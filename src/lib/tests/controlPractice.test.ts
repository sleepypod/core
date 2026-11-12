import { describe, expect, it } from 'vitest'
import { initialControlPractice, practiceCompletion, practiceWarmTime, reduceControlPractice, validPracticeTime } from '../controlPractice'

describe('local control practice', () => {
  it('keeps a chosen temperature separate until it is deliberately applied', () => {
    const initial = initialControlPractice('personal')
    const chosen = reduceControlPractice(initial, { type: 'temperature.step', degrees: -1 })
    expect(chosen.draftTargetF).toBe(75)
    expect(chosen.appliedTargetF).toBe(76)
    expect(practiceCompletion(chosen).temperature).toBe(false)
    const applied = reduceControlPractice(chosen, { type: 'temperature.apply' })
    expect(applied.appliedTargetF).toBe(75)
    expect(practiceCompletion(applied).temperature).toBe(true)
    expect(practiceCompletion(reduceControlPractice(applied, { type: 'temperature.step', degrees: 1 })).temperature).toBe(false)
    expect(initial).toEqual(initialControlPractice('personal'))
    expect(reduceControlPractice(applied, { type: 'reset' }).surface).toBe('personal')
  })

  it('matches owner controls by requesting a new target on each step without Apply', () => {
    const initial = initialControlPractice('owner')
    const colder = reduceControlPractice(initial, { type: 'temperature.step', degrees: -1 })
    expect(colder.draftTargetF).toBe(75)
    expect(colder.appliedTargetF).toBe(75)
    expect(practiceCompletion(colder).temperature).toBe(true)
    expect(reduceControlPractice(colder, { type: 'temperature.apply' })).toEqual(colder)
    const warmer = reduceControlPractice(colder, { type: 'temperature.step', degrees: 1 })
    expect(warmer.appliedTargetF).toBe(76)
    expect(practiceCompletion(warmer).temperature).toBe(true)
    expect(reduceControlPractice(warmer, { type: 'reset' })).toEqual(initial)
  })

  it('keeps repeated example adjustments bounded without changing the other lessons', () => {
    let state = initialControlPractice()
    for (let step = 0; step < 100; step++) state = reduceControlPractice(state, { type: 'temperature.step', degrees: -1 })
    expect(state.draftTargetF).toBe(65)
    for (let step = 0; step < 100; step++) state = reduceControlPractice(state, { type: 'temperature.step', degrees: 1 })
    expect(state.draftTargetF).toBe(90)
    expect(state.savedWake).toBe('07:00')
    expect(state.temperatureOn).toBe(true)
  })

  it('requires review of the exact wake time being saved', () => {
    let state = initialControlPractice()
    expect(reduceControlPractice(state, { type: 'wake.save' }).savedWake).toBe('07:00')
    state = reduceControlPractice(state, { type: 'wake.review' })
    state = reduceControlPractice(state, { type: 'wake.edit', time: '09:15' })
    expect(state.reviewedWake).toBeNull()
    state = reduceControlPractice(state, { type: 'wake.save' })
    expect(state.savedWake).toBe('07:00')
    state = reduceControlPractice(state, { type: 'wake.review' })
    state = reduceControlPractice(state, { type: 'wake.save' })
    expect(state.savedWake).toBe('09:15')
    expect(practiceCompletion(state).wake).toBe(true)
    expect(state.appliedTargetF).toBe(76)
  })

  it.each(['', '7:30', '24:00', '08:60', '08:00:00', 'not a time'])('never saves an invalid example time: %s', (time) => {
    let state = reduceControlPractice(initialControlPractice(), { type: 'wake.edit', time })
    state = reduceControlPractice(state, { type: 'wake.review' })
    state = reduceControlPractice(state, { type: 'wake.save' })
    expect(state.savedWake).toBe('07:00')
    expect(practiceCompletion(state).wake).toBe(false)
    expect(validPracticeTime(time)).toBe(false)
    expect(practiceWarmTime(time)).toBeNull()
  })

  it.each([['07:00', '06:30'], ['00:00', '23:30'], ['00:15', '23:45'], ['23:59', '23:29']])('shows warming before %s as %s', (wake, warming) => {
    expect(practiceWarmTime(wake)).toBe(warming)
  })

  it('teaches independent temperature and vibration Stop without deleting the next alarm', () => {
    let state = reduceControlPractice(initialControlPractice(), { type: 'stop.temperature' })
    expect(state.temperatureOn).toBe(false)
    expect(state.vibrationOn).toBe(true)
    expect(practiceCompletion(state).stop).toBe(false)
    state = reduceControlPractice(state, { type: 'stop.vibration' })
    expect(practiceCompletion(state).stop).toBe(true)
    expect(state.savedWake).toBe('07:00')
    expect(reduceControlPractice(state, { type: 'stop.vibration' })).toEqual(state)
  })

  it('does not mark skipped lessons complete and restarts without retained choices', () => {
    let state = reduceControlPractice(initialControlPractice(), { type: 'lesson', lesson: 'stop' })
    expect(practiceCompletion(state)).toEqual({ temperature: false, wake: false, stop: false })
    state = reduceControlPractice(state, { type: 'stop.temperature' })
    expect(reduceControlPractice(state, { type: 'reset' })).toEqual(initialControlPractice())
  })
})
