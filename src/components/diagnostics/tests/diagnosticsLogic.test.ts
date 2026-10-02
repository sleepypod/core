import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fmtF, fmtAge, fmtMs, fmtNum, minutesSince, fmtClock,
  VERDICT_STYLES, thermalDirection, biometricsFlowStatus,
} from '../diagnosticsLogic'

describe('formatters', () => {
  it('fmtF', () => {
    expect(fmtF(null)).toBe('—')
    expect(fmtF(undefined)).toBe('—')
    expect(fmtF(72.34)).toBe('72.3°F')
  })

  it('fmtAge', () => {
    expect(fmtAge(null)).toBe('no reading')
    expect(fmtAge(45)).toBe('45s')
    expect(fmtAge(89)).toBe('89s')
    expect(fmtAge(120)).toBe('2m')
  })

  it('fmtMs', () => {
    expect(fmtMs(undefined)).toBe('—')
    expect(fmtMs(0.4)).toBe('<1ms')
    expect(fmtMs(1.6)).toBe('2ms')
  })

  it('fmtNum', () => {
    expect(fmtNum(null)).toBe('—')
    expect(fmtNum(3.14159, 1)).toBe('3.1')
    expect(fmtNum(7)).toBe('7')
  })

  it('fmtClock', () => {
    expect(fmtClock(null)).toBe('—')
    expect(fmtClock('2026-05-31T13:05:00Z')).toMatch(/\d/)
  })
})

describe('time-relative formatters', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-31T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('minutesSince clamps to 0 and floors', () => {
    expect(minutesSince(Date.now())).toBe(0)
    expect(minutesSince(Date.now() + 60_000)).toBe(0) // future → clamped
    expect(minutesSince(Date.now() - 5 * 60_000)).toBe(5)
  })
})

describe('VERDICT_STYLES', () => {
  it('covers the five thermal verdicts', () => {
    expect(Object.keys(VERDICT_STYLES).sort()).toEqual(['delivering', 'holding', 'off', 'stalled', 'unknown'])
  })
})

describe('thermalDirection', () => {
  const base = { verdict: 'delivering', isPowered: true, targetTempF: 76, currentTempF: 80 }

  it('reports COOLING when the target is below the bed', () => {
    expect(thermalDirection(base)).toEqual({ label: 'COOLING', className: 'text-cool' })
  })

  it('reports WARMING when the target is above the bed', () => {
    expect(thermalDirection({ ...base, targetTempF: 84 })).toEqual({ label: 'WARMING', className: 'text-warm' })
  })

  it('reports HOLDING within ±0.5°F', () => {
    expect(thermalDirection({ ...base, targetTempF: 80.5 }).label).toBe('HOLDING')
    expect(thermalDirection({ ...base, targetTempF: 79.5 }).label).toBe('HOLDING')
  })

  it('falls back to the verdict when not delivering or data is missing', () => {
    expect(thermalDirection({ ...base, verdict: 'stalled' })).toEqual(VERDICT_STYLES.stalled)
    expect(thermalDirection({ ...base, isPowered: false })).toEqual(VERDICT_STYLES.delivering)
    expect(thermalDirection({ ...base, currentTempF: null })).toEqual(VERDICT_STYLES.delivering)
    expect(thermalDirection({ ...base, verdict: 'weird' })).toEqual({ label: 'WEIRD', className: 'text-fg-2' })
  })
})

describe('biometricsFlowStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-31T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  const occ = (l: boolean, r: boolean) => ({ left: { occupied: l }, right: { occupied: r } })
  const files = (n: number) => ({ rawFiles: { left: n, right: 0 } })

  it('error when nothing written', () => {
    expect(biometricsFlowStatus([], undefined, undefined).tone).toBe('error')
    expect(biometricsFlowStatus([], occ(false, false), files(0)).tone).toBe('error')
  })

  it('ok when fresh', () => {
    const rows = [{ timestamp: new Date(Date.now() - 2 * 60_000).toISOString() }]
    const res = biometricsFlowStatus(rows, occ(true, false), files(4))
    expect(res.tone).toBe('ok')
    expect(res.label).toContain('2m ago')
    expect(res.label).toContain('4 RAW')
  })

  it('warn when occupied but stale', () => {
    const rows = [{ timestamp: new Date(Date.now() - 30 * 60_000).toISOString() }]
    const res = biometricsFlowStatus(rows, occ(true, false), files(4))
    expect(res.tone).toBe('warn')
    expect(res.label).toContain('30m ago')
  })

  it('warn when occupied but no vitals at all (raw files exist)', () => {
    const res = biometricsFlowStatus([], occ(false, true), files(2))
    expect(res.tone).toBe('warn')
    expect(res.label).toContain('no vitals recorded')
  })

  it('idle when empty bed and stale', () => {
    const rows = [{ timestamp: new Date(Date.now() - 30 * 60_000).toISOString() }]
    const res = biometricsFlowStatus(rows, occ(false, false), files(4))
    expect(res.tone).toBe('idle')
    expect(res.label).toContain('30m ago')
  })
})
