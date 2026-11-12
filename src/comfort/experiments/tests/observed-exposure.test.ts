import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { experimentDigest } from '../access'
import { experimentAuthorityRequestId, type ExperimentSample } from '../exposure'
import { exposureFromObservations } from '../observed-exposure'
import type { RetainedExperimentWindow } from '../observations'
import { createScheduledExperimentPlan, experimentNightAt, experimentPlanHash } from '../plan'
import { resolveExperimentSchedule } from '../schedule'
import { context, createdAt, fixtureSchedule } from './fixture'

function fixture() {
  const plan = createScheduledExperimentPlan(context, 69, resolveExperimentSchedule(fixtureSchedule(), '2026-11-13', createdAt), createdAt)
  if (plan.version !== 2) throw new Error('Missing scheduled fixture')
  const window = plan.schedule.windows[0], night = experimentNightAt(plan, window.windowStart)
  if (!night) throw new Error('Missing assigned night')
  const sample: ExperimentSample = { at: window.windowStart, deviceAt: window.windowStart, presenceAt: window.windowStart,
    targetF: night.targetF, powered: true, occupied: true, waterAdequate: true, priming: false, vibrating: false,
    baseMoving: false, bindingHash: context.bindingHash, routineHash: context.routineHash, wakeHash: context.wakeHash,
    selectedRequestId: experimentAuthorityRequestId(plan, night.date), selectedUntil: window.windowStart + 10_000, attributionAmbiguous: false }
  const id = randomUUID()
  const retained: RetainedExperimentWindow = { binding: { version: 1, id, subjectKey: context.subjectKey,
    admissionId: randomUUID(), planId: plan.id, planHash: experimentPlanHash(plan), nightDate: night.date,
    windowStart: window.windowStart, windowEnd: window.windowEnd, sides: ['left', 'right'], createdAt: window.windowStart },
  observations: [{ version: 1, id: randomUUID(), windowId: id, at: window.windowStart,
    zones: [{ side: 'left', sample: { ...sample } }, { side: 'right', sample: { ...sample } }] }],
  finalizedAt: window.windowEnd, sourceDigest: experimentDigest('Synthetic verified source') }
  const result = () => exposureFromObservations(plan, retained, { manualChanges: 0, unconfirmedCommands: 0,
    admissionInterrupted: false, interruptedAt: null, digest: experimentDigest('Synthetic interruption source') }, window.windowEnd)
  return { plan, sample, retained, result }
}

it('counts a person lying across both physical zones once', () => {
  expect(fixture().result()).toMatchObject({ observedMs: 10_000, matchedTargetMs: 10_000, occupiedMs: 10_000, qualifiedMs: 10_000 })
})

it('requires matching treatment on every occupied zone, while allowing a verified empty half', () => {
  const test = fixture(), right = test.retained.observations[0].zones[1].sample
  right.targetF = 71
  expect(test.result()).toMatchObject({ matchedTargetMs: 0, occupiedMs: 10_000, qualifiedMs: 0 })
  right.occupied = false
  expect(test.result()).toMatchObject({ matchedTargetMs: 10_000, occupiedMs: 10_000, qualifiedMs: 10_000 })
})

it('does not guess another zone is empty when its occupancy source is missing', () => {
  const test = fixture(), right = test.retained.observations[0].zones[1].sample
  right.presenceAt = null
  right.occupied = null
  expect(test.result()).toMatchObject({ observedMs: 10_000, occupiedMs: 0, qualifiedMs: 0, attributionAmbiguous: false })
})

it('does not qualify a matching temperature selected by another controller request', () => {
  const test = fixture()
  test.retained.observations[0].zones[1].sample.selectedRequestId = 'a-different-request'
  expect(test.result()).toMatchObject({ matchedTargetMs: 10_000, qualifiedMs: 0 })
})

it('limits each recorded interval and retains explicit context or identity changes', () => {
  const test = fixture(), sample = test.retained.observations[0].zones[1].sample
  sample.bindingHash = 'f'.repeat(64)
  sample.attributionAmbiguous = true
  expect(test.result()).toMatchObject({ observedMs: 10_000, qualifiedMs: 0, attributionAmbiguous: true })
  expect(test.result().bindingHash).not.toBe(context.bindingHash)
})

it('stops qualifying at the selected request expiry even if a process crash prevents another packet', () => {
  const test = fixture(), sample = test.retained.observations[0].zones[1].sample
  sample.selectedUntil = sample.at + 5000
  expect(test.result()).toMatchObject({ observedMs: 10_000, occupiedMs: 10_000, qualifiedMs: 5000 })
})

it('clips an interval at an actual interruption without shortening the original reviewed night', () => {
  const test = fixture(), { binding } = test.retained
  const exposure = exposureFromObservations(test.plan, test.retained, { manualChanges: 1, unconfirmedCommands: 0,
    admissionInterrupted: true, interruptedAt: binding.windowStart + 4000, digest: experimentDigest('Synthetic stop') }, binding.windowEnd)
  expect(exposure).toMatchObject({ windowStart: binding.windowStart, windowEnd: binding.windowEnd,
    observedMs: 4000, qualifiedMs: 4000, manualChanges: 1, safetyInterruptions: 1 })
})
