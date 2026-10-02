import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest'
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

  afterEach(() => {
    vi.useRealTimers()
  })

  it('no notification initially', () => {
    expect(getPrimeCompletedAt()).toBeNull()
  })

  it('sets notification on isPriming true → false transition', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T01:02:03.987Z'))
    trackPrimingState(true)
    expect(getPrimeCompletedAt()).toBeNull()

    trackPrimingState(false)
    expect(getPrimeCompletedAt()).toBe(1_784_509_323)
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

  it('does not clear a stored completion merely because priming remains true', () => {
    const g = globalThis as Record<string, unknown>
    const completed = new Date('2026-07-20T01:02:03.987Z')
    g['__sp_prime_completedAt__'] = completed
    g['__sp_prime_wasPriming__'] = true

    trackPrimingState(true)

    expect(g['__sp_prime_completedAt__']).toBe(completed)
    expect(getPrimeCompletedAt()).toBe(1_784_509_323)
  })
})
