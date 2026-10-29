import { describe, expect, it } from 'vitest'
import { ALL_SENSOR_TYPES } from '@/src/hooks/useSensorStream'
import { STREAM_GROUPS, fmtSeen, groupForType } from '../streamGroups'

describe('groupForType', () => {
  it('puts the firmware water and cover-health frames in Freezer and Presence', () => {
    expect(groupForType('frzWater')).toBe('freezer')
    expect(groupForType('sensHealth')).toBe('presence')
  })

  it('keeps the existing mappings', () => {
    expect(groupForType('frzHealth')).toBe('freezer')
    expect(groupForType('capSense2')).toBe('presence')
    expect(groupForType('lps')).toBe('piezo')
    expect(groupForType('deviceStatus')).toBe('status')
  })

  it('returns undefined for types outside every group', () => {
    expect(groupForType('nope')).toBeUndefined()
  })

  it('assigns every streamed sensor type to exactly one group', () => {
    for (const type of ALL_SENSOR_TYPES) {
      expect(STREAM_GROUPS.filter(g => g.types.includes(type)), type).toHaveLength(1)
    }
  })
})

describe('fmtSeen', () => {
  it('compacts ages', () => {
    expect(fmtSeen(null)).toBe('—')
    expect(fmtSeen(1_234)).toBe('1.2s')
    expect(fmtSeen(12_400)).toBe('12s')
    expect(fmtSeen(4 * 60_000 + 5_000)).toBe('4m')
    expect(fmtSeen(2 * 3_600_000)).toBe('2h')
  })
})
