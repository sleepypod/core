import { describe, expect, it } from 'vitest'
import { currentLearningRead, stageLearning, temperatureLearning } from '../learningJourneyModel'

describe('learning progress semantics', () => {
  it('withdraws inventory after failed, pending, future or expired reads', () => {
    const now = 1_800_000_000_000
    expect(currentLearningRead(now, now, false, false)).toBe(true)
    for (const [at, error, loading] of [[now - 300_001, false, false], [now + 60_001, false, false],
      [now, true, false], [now, false, true], [0, false, false]] as const) {
      expect(currentLearningRead(now, at, error, loading)).toBe(false)
    }
    expect(currentLearningRead(null, now, false, false)).toBe(false)
  })
  it('keeps stored stage candidates separate from selected and unavailable estimators', () => {
    expect(stageLearning(undefined).state).toBe('Needs a current read')
    expect(stageLearning({ model: null, active: false }).state).toBe('Rules are available')
    expect(stageLearning({ model: { version: 'candidate' }, active: false }).state).toBe('Candidate saved')
    expect(stageLearning({ model: { version: 'candidate' }, active: true }).state).toBe('Pod model selected')
  })
  it('counts only qualified nights and never calls fitting readiness activation', () => {
    const status = { completeNights: 13, requiredNights: 20, canTrain: false, model: null }
    expect(temperatureLearning(status).next).toContain('7 more qualifying nights')
    expect(temperatureLearning({ ...status, completeNights: 20, canTrain: true }).state).toBe('Ready to review a fit')
    expect(temperatureLearning({ ...status, completeNights: Number.NaN }).progress).toBeUndefined()
    expect(temperatureLearning({ ...status, requiredNights: 0 }).state).toBe('Needs a current read')
  })
  it('does not turn a trained, stale or failed model into a passed comparison', () => {
    const status = { completeNights: 20, requiredNights: 20, canTrain: true,
      model: { current: true, validation: { passesFeedbackCheck: false } } }
    expect(temperatureLearning(status).state).toBe('Comparison needs improvement')
    expect(temperatureLearning({ ...status, model: { ...status.model, current: false } }).state).toBe('Recheck changed evidence')
    const passed = temperatureLearning({ ...status, model: { current: true, validation: { passesFeedbackCheck: true } } })
    expect(passed.state).toBe('Research comparison passed')
    expect(passed.next).toContain('independent hardware')
    expect(passed.description).toContain('does not enable')
  })
})
