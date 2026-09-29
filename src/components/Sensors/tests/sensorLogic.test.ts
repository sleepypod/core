import { describe, expect, it } from 'vitest'
import { STREAM_GROUPS, fmtSeen, groupForType } from '../streamGroups'
import { cellTint } from '../BedTempMatrix'
import { freezerStatus } from '../FreezerHealthCard'
import { zoneActivity } from '../PresenceCard'
import type { FrzHealthFrame } from '@/src/hooks/useSensorStream'

describe('streamGroups', () => {
  it('names the six streams as Health does, in order', () => {
    expect(STREAM_GROUPS.map(g => g.label)).toEqual(['Device', 'Piezo', 'Presence', 'Bed temp', 'Freezer', 'Log'])
  })

  it('maps frame types to their group', () => {
    expect(groupForType('deviceStatus')).toBe('status')
    expect(groupForType('piezo-dual')).toBe('piezo')
    expect(groupForType('capSense')).toBe('presence')
    expect(groupForType('capSense2')).toBe('presence')
    expect(groupForType('bedTemp2')).toBe('bedTemp')
    expect(groupForType('frzTherm')).toBe('freezer')
    expect(groupForType('gesture')).toBe('log')
    expect(groupForType('unknown')).toBeUndefined()
  })

  it('formats last-seen ages', () => {
    expect(fmtSeen(null)).toBe('—')
    expect(fmtSeen(120)).toBe('0.1s')
    expect(fmtSeen(9_949)).toBe('9.9s')
    expect(fmtSeen(10_000)).toBe('10s')
    expect(fmtSeen(59_400)).toBe('59s')
    expect(fmtSeen(60_000)).toBe('1m')
    expect(fmtSeen(3_599_000)).toBe('59m')
    expect(fmtSeen(7_200_000)).toBe('2h')
  })
})

describe('cellTint', () => {
  it('uses the neutral surface when a value or the mean is missing', () => {
    expect(cellTint(null, 80)).toBe('var(--surface-active)')
    expect(cellTint(80, null)).toBe('var(--surface-active)')
  })

  it('tints cooler cells cool and warmer cells warm, stronger with deviation', () => {
    expect(cellTint(79, 80)).toBe('color-mix(in srgb, var(--accent-cool) 27%, var(--surface-card))')
    expect(cellTint(81, 80)).toBe('color-mix(in srgb, var(--accent-warm) 27%, var(--surface-card))')
    expect(cellTint(80, 80)).toBe('color-mix(in srgb, var(--accent-warm) 14%, var(--surface-card))')
    // saturates at 2° of deviation
    expect(cellTint(70, 80)).toBe('color-mix(in srgb, var(--accent-cool) 40%, var(--surface-card))')
  })
})

describe('freezerStatus', () => {
  const health = (over: Partial<{ tec: number, fan: number }> = {}): FrzHealthFrame => ({
    type: 'frzHealth',
    ts: 1,
    left: { pumpRpm: 2400, pumpDuty: 50, tecCurrent: over.tec ?? 1, flowrate: null },
    right: { pumpRpm: 2400, pumpDuty: 50, tecCurrent: 1, flowrate: null },
    fan: { rpm: over.fan ?? 1200, duty: 50, bottomRpm: null },
  })

  it('reports no data before anything arrives', () => {
    expect(freezerStatus(undefined, undefined, false)).toEqual({ tone: 'muted', label: 'No data' })
  })

  it('is normal with healthy readings', () => {
    expect(freezerStatus(health(), 'ok', true)).toEqual({ tone: 'ok', label: 'Normal' })
    expect(freezerStatus(undefined, undefined, true)).toEqual({ tone: 'ok', label: 'Normal' })
  })

  it('warns on low water, high TEC current, or a slow fan (in that priority)', () => {
    expect(freezerStatus(health({ tec: 6, fan: 10 }), 'low', true).label).toBe('Water low')
    expect(freezerStatus(health({ tec: 5.1 }), 'ok', true)).toEqual({ tone: 'warn', label: 'High TEC' })
    expect(freezerStatus(health({ tec: 5 }), 'ok', true).label).toBe('Normal')
    expect(freezerStatus(health({ fan: 99 }), 'ok', true)).toEqual({ tone: 'warn', label: 'Fan slow' })
    expect(freezerStatus(health({ fan: 100 }), 'ok', true).label).toBe('Normal')
  })
})

describe('zoneActivity', () => {
  it('takes the busier of the two channels per zone, normalized and clamped', () => {
    const variance = [0.1, 0.25, 0, 0, 2, 0.05]
    expect(zoneActivity(variance, 0)).toBeCloseTo(0.5)
    expect(zoneActivity(variance, 1)).toBe(0)
    expect(zoneActivity(variance, 2)).toBe(1)
    expect(zoneActivity([], 1)).toBe(0)
  })
})
