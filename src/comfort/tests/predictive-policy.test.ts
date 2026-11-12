import { describe, expect, it } from 'vitest'
import { previewPredictiveTarget } from '../predictive-policy'
import { predictiveTargetPreviewSchema } from '../predictive-contract'
import { predictiveFixture, predictiveHorizons } from './predictiveFixture'

describe('research water target ranking', () => {
  it('compares holding with a supported one-degree step without modifying state or enabling control', () => {
    const input = predictiveFixture(), before = structuredClone(input)
    const result = previewPredictiveTarget(input)
    expect(result).toMatchObject({ disposition: 'candidate', desiredWaterF: 70, proposedTargetF: 69,
      activationAvailable: false, mode: 'research_preview', expiresAt: input.context.now + 15_000 })
    expect(result.comparisons.map(item => item.targetF)).toEqual([70, 69, 71])
    expect(input).toEqual(before)
  })

  it('holds when uncertainty spans the objective, when improvement is small, or when directions conflict', () => {
    const input = predictiveFixture()
    input.hold = predictiveHorizons(70, 2)
    expect(previewPredictiveTarget(input).disposition).toBe('hold')
    input.hold = predictiveHorizons(71)
    input.steps[0] = { targetF: 69, ...predictiveHorizons(70.7) }
    expect(previewPredictiveTarget(input).disposition).toBe('hold')
    input.hold = predictiveHorizons(73)
    input.steps = [69, 71].map(targetF => ({ targetF, ...predictiveHorizons(70) }))
    expect(previewPredictiveTarget(input).disposition).toBe('hold')
  })

  it('does not trade a worse early horizon for a favorable later horizon', () => {
    const input = predictiveFixture()
    input.steps[0].predictions[0] = predictiveHorizons(74).predictions[0]
    expect(previewPredictiveTarget(input).disposition).toBe('hold')
  })

  it('respects the 70-degree floor even when a lower target forecasts better tracking', () => {
    const input = predictiveFixture()
    input.state.config.minimumF = 70
    expect(previewPredictiveTarget(input)).toMatchObject({ disposition: 'hold', proposedTargetF: 70 })
    expect(previewPredictiveTarget(input).comparisons.map(value => value.targetF)).toEqual([70, 71])
  })

  it('tracks the bounded personal preference, not the rate-limited next command', () => {
    const input = predictiveFixture()
    input.state.offsetF = -3
    input.context.device.targetF = 72
    input.hold = predictiveHorizons(73)
    input.steps = [{ targetF: 71, ...predictiveHorizons(69.5) }, { targetF: 73, ...predictiveHorizons(74) }]
    expect(previewPredictiveTarget(input)).toMatchObject({ desiredWaterF: 69, proposedTargetF: 71, disposition: 'candidate' })
  })

  it.each(['off', 'active'] as const)('withholds outside Preview: %s', (mode) => {
    const input = predictiveFixture()
    input.state.config.mode = mode
    expect(previewPredictiveTarget(input)).toMatchObject({ disposition: 'withheld', proposedTargetF: null })
  })

  it.each(['manual', 'unknown', 'stale', 'future', 'unoccupied', 'water', 'vibration', 'base', 'off', 'paused', 'cooldown', 'away', 'alarm', 'vitals'])(
    'keeps the existing comfort guard for %s', (failure) => {
      const input = predictiveFixture(), { context, state } = input
      if (failure === 'manual') context.owner = 'manual'
      if (failure === 'unknown') context.targetKnown = false
      if (failure === 'stale') context.device.observedAt = context.now - 15_001
      if (failure === 'future') context.device.observedAt = context.now + 1
      if (failure === 'unoccupied') context.presence.occupied = false
      if (failure === 'water') context.device.waterAdequate = false
      if (failure === 'vibration') context.device.vibrating = true
      if (failure === 'base') context.device.baseMoving = null
      if (failure === 'off') context.device.powered = false
      if (failure === 'paused') state.pausedUntil = context.now + 60_000
      if (failure === 'cooldown') state.lastAppliedAt = context.now - 60_000
      if (failure === 'away') context.eitherAway = true
      if (failure === 'alarm') context.alarmOverride = true
      if (failure === 'vitals') state.config.sensorAware = true
      expect(previewPredictiveTarget(input)).toMatchObject({ disposition: 'withheld', proposedTargetF: null, expiresAt: null })
    })

  it.each(['end', 'warming', 'phase'])('does not forecast across the next %s boundary', (kind) => {
    const input = predictiveFixture(), window = input.context.window
    if (!window) throw new Error('The predictive fixture requires an overnight window')
    if (kind === 'end') window.end = input.context.now + 30 * 60_000
    if (kind === 'warming') window.alarmAt = input.context.now + 60 * 60_000
    if (kind === 'phase') window.phases = { revision: 'example', startF: 70,
      changes: [{ id: 'next', at: input.context.now + 30 * 60_000, temperatureF: 71 }] }
    expect(previewPredictiveTarget(input)).toMatchObject({ disposition: 'withheld', proposedTargetF: null })
  })

  it('refuses invalid, repeated or missing hold horizons and duplicate or distant candidates', () => {
    const input = predictiveFixture()
    input.hold.predictions.pop()
    expect(previewPredictiveTarget(input).disposition).toBe('withheld')
    input.hold = predictiveHorizons(73)
    input.hold.predictions[1].minutes = 15
    expect(previewPredictiveTarget(input).disposition).toBe('withheld')
    input.hold = predictiveHorizons(73)
    input.hold.predictions[0].lowerF = 80
    expect(previewPredictiveTarget(input).disposition).toBe('withheld')
    input.hold = predictiveHorizons(73)
    input.steps[1].targetF = 69
    expect(previewPredictiveTarget(input).disposition).toBe('withheld')
    input.steps[1].targetF = 72
    expect(previewPredictiveTarget(input).disposition).toBe('withheld')
  })

  it('does not impute an unsupported direction or label a held target as an adjustment', () => {
    const input = predictiveFixture()
    input.steps = []
    const result = previewPredictiveTarget(input)
    expect(result).toMatchObject({ disposition: 'hold', proposedTargetF: 70 })
    expect(result.comparisons[1]).toMatchObject({ predictions: [], bestErrorF: null, worstErrorF: null })
  })

  it('expires with the actual reading and refuses an already-expired source', () => {
    const input = predictiveFixture()
    input.context.device.observedAt = input.context.now - 14_999
    expect(previewPredictiveTarget(input).expiresAt).toBe(input.context.now + 1)
    input.context.now++
    expect(previewPredictiveTarget(input).disposition).toBe('withheld')
  })

  it('rejects contradictory or actionable transport envelopes', () => {
    const preview = previewPredictiveTarget(predictiveFixture())
    expect(predictiveTargetPreviewSchema.safeParse({ ...preview, activationAvailable: true }).success).toBe(false)
    expect(predictiveTargetPreviewSchema.safeParse({ ...preview, disposition: 'hold' }).success).toBe(false)
    expect(predictiveTargetPreviewSchema.safeParse({ ...preview, proposedTargetF: 68 }).success).toBe(false)
    expect(predictiveTargetPreviewSchema.safeParse({ ...preview, expiresAt: preview.generatedAt + 60_000 }).success).toBe(false)
  })
})
