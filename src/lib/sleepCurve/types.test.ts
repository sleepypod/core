import { describe, expect, it } from 'vitest'
import { coolingIntensityMeta, phaseColors, phaseLabels } from './types'

describe('sleep curve display metadata', () => {
  it('exposes every phase label exactly', () => {
    expect(phaseLabels).toEqual({
      warmUp: 'Wind Down',
      coolDown: 'Fall Asleep',
      deepSleep: 'Deep Sleep',
      maintain: 'Maintain',
      preWake: 'Pre-Wake',
      wake: 'Wake',
    })
  })

  it('exposes every phase color exactly', () => {
    expect(phaseColors).toEqual({
      warmUp: '#f59e0b',
      coolDown: '#6366f1',
      deepSleep: '#2563eb',
      maintain: '#8b5cf6',
      preWake: '#f97316',
      wake: '#eab308',
    })
  })

  it('exposes the complete cooling-intensity copy', () => {
    expect(coolingIntensityMeta).toEqual({
      cool: { label: 'Cool', description: 'Extra cooling for hot sleepers' },
      balanced: { label: 'Balanced', description: 'Science-backed defaults for most people' },
      warm: { label: 'Warm', description: 'Gentler cooling, warmer wake-up' },
    })
  })
})
