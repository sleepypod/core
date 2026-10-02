import { describe, expect, it } from 'vitest'
import { resolveSection, SECTIONS } from '../sections'

describe('resolveSection', () => {
  it('returns the ?section= value when it names a section', () => {
    expect(resolveSection('appearance', null)).toBe('appearance')
    expect(resolveSection('network', null)).toBe('network')
  })

  it('falls back to legacy ?tab= values', () => {
    for (const tab of ['device', 'sides', 'gestures', 'mqtt', 'backup']) {
      expect(resolveSection(null, tab)).toBe(tab)
    }
  })

  it('prefers ?section= over ?tab=', () => {
    expect(resolveSection('updates', 'device')).toBe('updates')
  })

  it('ignores an unknown section and uses the tab instead', () => {
    expect(resolveSection('nope', 'sides')).toBe('sides')
  })

  it('returns null when neither names a section', () => {
    expect(resolveSection(null, null)).toBeNull()
    expect(resolveSection('bogus', 'also-bogus')).toBeNull()
  })

  it('lists all nine sections A–Z', () => {
    expect(SECTIONS.map(s => s.id)).toEqual(['appearance', 'backup', 'device', 'gestures', 'homekit', 'mqtt', 'network', 'sides', 'updates'])
  })
})
