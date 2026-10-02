import { describe, expect, it } from 'vitest'
import { resolveSleepSection, SLEEP_SECTIONS } from '../sleepViews'

describe('resolveSleepSection', () => {
  it('lands on Nights unless ?view=biometrics', () => {
    expect(resolveSleepSection(null)).toBe('nights')
    expect(resolveSleepSection('bogus')).toBe('nights')
    expect(resolveSleepSection('biometrics')).toBe('biometrics')
  })

  it('lists Nights first', () => {
    expect(SLEEP_SECTIONS.map(s => s.label)).toEqual(['Nights', 'Biometrics'])
  })
})
