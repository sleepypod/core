import { describe, it, expect, beforeEach } from 'vitest'
import {
  trackPrimingState,
  getPrimeCompletedAt,
  dismissPrimeNotification,
  resetPrimingState,
} from '../primeNotification'

describe('primeNotification', () => {
  beforeEach(() => {
    resetPrimingState()
  })

  it('no notification initially', () => {
    expect(getPrimeCompletedAt()).toBeNull()
  })

  it('sets notification on isPriming true → false transition', () => {
    trackPrimingState(true)
    expect(getPrimeCompletedAt()).toBeNull()

    trackPrimingState(false)
    expect(getPrimeCompletedAt()).toBeTypeOf('number')
  })

  it('does not set notification on false → false', () => {
    trackPrimingState(false)
    expect(getPrimeCompletedAt()).toBeNull()
  })

  it('clears notification when new priming cycle starts', () => {
    trackPrimingState(true)
    trackPrimingState(false)
    expect(getPrimeCompletedAt()).not.toBeNull()

    // New priming cycle
    trackPrimingState(true)
    expect(getPrimeCompletedAt()).toBeNull()
  })

  it('dismissPrimeNotification clears notification', () => {
    trackPrimingState(true)
    trackPrimingState(false)
    expect(getPrimeCompletedAt()).not.toBeNull()

    dismissPrimeNotification()
    expect(getPrimeCompletedAt()).toBeNull()
  })

  it('resetPrimingState clears everything', () => {
    trackPrimingState(true)
    trackPrimingState(false)

    resetPrimingState()
    expect(getPrimeCompletedAt()).toBeNull()

    // After reset, false → false should not trigger
    trackPrimingState(false)
    expect(getPrimeCompletedAt()).toBeNull()
  })
})
