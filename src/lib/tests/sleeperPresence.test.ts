import { describe, expect, it, vi } from 'vitest'
import type { Side } from '@/src/hardware/types'
import type { OccupancyResult } from '../occupancy'
import { readSleeperPresence } from '../sleeperPresence'

const now = Date.parse('2026-10-29T22:00:00Z')
function zone(occupied: boolean, side: Side): OccupancyResult {
  return { occupied, available: true, classification: occupied ? 'person' : 'none',
    movement: { active: false, peakScore: 0 }, vitals: { heartRate: null, breathingRate: null, humanRange: null },
    level: { active: occupied, ageMs: 100, sampleAt: now - 500, sourceKey: (side === 'left' ? 'a' : 'b').repeat(64),
      deviation: occupied ? 20 : 0, threshold: 10, zoneDeviations: occupied ? [8, 8, 4] : [0, 0, 0], zones: occupied ? 2 : 0 } }
}

describe('logical sole-sleeper presence', () => {
  it.each(['left', 'right', 'middle'] as const)('accepts a sole sleeper on %s without creating another person or changing physical evidence', (position) => {
    const left = zone(position !== 'right', 'left'), right = zone(position !== 'left', 'right')
    const before = JSON.stringify({ left, right })
    const read = vi.fn((side: Side) => side === 'left' ? left : right)
    const result = readSleeperPresence('left', { bedMode: 'solo-left', unusedZoneMode: 'follow' }, now, read)
    expect(result).toMatchObject({ occupied: true, available: true, observedAt: now - 100, entry: { state: 'present', measuredAt: now - 500 } })
    expect(result.entry?.sourceKey).not.toBe(left.level.sourceKey)
    expect(read.mock.calls.map(call => call[0])).toEqual(['left', 'right'])
    expect(JSON.stringify({ left, right })).toBe(before)
    expect(readSleeperPresence('right', { bedMode: 'solo-left' }, now, read)).toEqual(result)
  })

  it('requires both calibrated zones to establish absence', () => {
    const left = zone(false, 'left'), right = zone(false, 'right')
    const read = (side: Side) => side === 'left' ? left : right
    expect(readSleeperPresence('left', { bedMode: 'solo-left' }, now, read)).toMatchObject({ occupied: false, available: true, entry: { state: 'absent' } })
    right.available = false
    expect(readSleeperPresence('left', { bedMode: 'solo-left' }, now, read)).toEqual({ observedAt: now - 100, occupied: false, available: false })
    right.classification = 'person'
    expect(readSleeperPresence('left', { bedMode: 'solo-left' }, now, read)).toMatchObject({ occupied: true, available: false })
  })

  it('does not turn residual movement or light loads into a calibrated bed-entry event', () => {
    const left = zone(false, 'left'), right = zone(false, 'right')
    right.classification = 'person'
    right.movement.active = true
    expect(readSleeperPresence('left', { bedMode: 'solo-left' }, now, side => side === 'left' ? left : right).entry?.state).toBe('unknown')
    right.classification = 'light'
    right.level.active = true
    expect(readSleeperPresence('left', { bedMode: 'solo-left' }, now, side => side === 'left' ? left : right)).toMatchObject({ occupied: false, entry: { state: 'unknown' } })
  })

  it('keeps two active sleepers separate and does not inspect the other zone', () => {
    const read = vi.fn((side: Side) => zone(side === 'right', side))
    const left = readSleeperPresence('left', { bedMode: 'two' }, now, read)
    expect(left).toMatchObject({ occupied: false, available: true, entry: { state: 'absent', sourceKey: 'a'.repeat(64) } })
    expect(read.mock.calls).toEqual([['left']])
  })

  it('matches the Python temporary-away convention and withholds when nobody is active', () => {
    const read = vi.fn((side: Side) => zone(side === 'right', side))
    expect(readSleeperPresence('left', { bedMode: 'two', right: { awayMode: true } }, now, read).occupied).toBe(true)
    read.mockClear()
    expect(readSleeperPresence('left', { bedMode: 'solo-left', left: { awayMode: true } }, now, read)).toEqual({ observedAt: null, occupied: false, available: false })
    expect(read).not.toHaveBeenCalled()
  })

  it.each(['stale', 'future', 'missing-key', 'different-frame'] as const)('withholds fused availability for %s data', (failure) => {
    const left = zone(false, 'left'), right = zone(true, 'right')
    if (failure === 'stale') right.level.ageMs = 30_001
    if (failure === 'future') right.level.sampleAt = now + 1
    if (failure === 'missing-key') right.level.sourceKey = undefined
    if (failure === 'different-frame') right.level.sampleAt = now - 1000
    const result = readSleeperPresence('left', { bedMode: 'solo-left' }, now, side => side === 'left' ? left : right)
    expect(result.available).toBe(false)
    expect(result.entry).toBeUndefined()
  })

  it('binds qualification to both calibrations and the logical source side', () => {
    const left = zone(true, 'left'), right = zone(false, 'right')
    const read = (side: Side) => side === 'left' ? left : right
    const before = readSleeperPresence('left', { bedMode: 'solo-left' }, now, read).entry?.sourceKey
    right.level.sourceKey = 'c'.repeat(64)
    const after = readSleeperPresence('left', { bedMode: 'solo-left' }, now, read).entry?.sourceKey
    expect(before).not.toBe(after)
    expect(readSleeperPresence('right', { bedMode: 'solo-right' }, now, read).entry?.sourceKey).not.toBe(after)
  })
})
