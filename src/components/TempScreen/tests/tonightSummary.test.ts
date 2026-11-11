import { describe, expect, it } from 'vitest'
import type { ComfortStatus } from '@/src/comfort/contract'
import { currentTonightRead, morningInPodZone, personalComfortMode } from '../tonightSummary'
const now = Date.parse('2026-11-10T16:00:00Z')
function status(mode: 'off' | 'preview' | 'active'): ComfortStatus {
  return { generatedAt: now, state: { config: { mode }, pausedUntil: 0 }, runtime: 'running', activation: { current: true } } as ComfortStatus
}
describe('Tonight summary', () => {
  it('separates Off, Preview and qualified active adjustment from model training', () => {
    expect(personalComfortMode(status('off'), now)).toBe('Off')
    expect(personalComfortMode(status('preview'), now)).toBe('Preview · no adjustments')
    expect(personalComfortMode(status('active'), now)).toBe('Active · bounded adjustments')
  })
  it('does not call an unqualified or stopped controller active', () => {
    const value = status('active')
    value.activation.current = false
    expect(personalComfortMode(value, now)).toBe('Activation not confirmed')
    value.activation.current = true
    value.runtime = 'stopped'
    expect(personalComfortMode(value, now)).toContain('Unavailable')
    value.runtime = 'running'
    if (value.state) value.state.pausedUntil = now + 60_000
    expect(personalComfortMode(value, now)).toContain('Paused')
  })
  it('withdraws failed, old and future reads and source timestamps', () => {
    expect(currentTonightRead(now, false, now)).toBe(true)
    for (const updated of [0, NaN, now - 90_001, now + 60_001]) expect(currentTonightRead(updated, false, now)).toBe(false)
    expect(currentTonightRead(now, true, now)).toBe(false)
    expect(personalComfortMode(undefined, now)).toBe('Not checked')
    expect(personalComfortMode({ ...status('active'), generatedAt: now - 90_001 }, now)).toBe('Not checked')
  })
  it('uses Pod timezone, including DST, rather than browser morning', () => {
    expect(morningInPodZone(now, 'America/Los_Angeles')).toBe(true)
    expect(morningInPodZone(now, 'Asia/Tokyo')).toBe(false)
    expect(morningInPodZone(Date.parse('2026-11-01T11:30:00Z'), 'America/Los_Angeles')).toBe(false)
    expect(morningInPodZone(Date.parse('2026-11-01T12:30:00Z'), 'America/Los_Angeles')).toBe(true)
    expect(morningInPodZone(now, 'invalid')).toBe(false)
    expect(morningInPodZone(now, undefined)).toBe(false)
  })
})
