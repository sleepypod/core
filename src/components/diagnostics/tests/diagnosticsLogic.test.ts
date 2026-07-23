import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fmtF, fmtAge, fmtMs, fmtNum, minutesSince, fmtRel, fmtClock, fmtDayLabel,
  VERDICT_STYLES, buildWeekLanes, jobTone, fmtJobValue, biometricsFlowStatus, thermalTrendPoints,
  type SchedJob, type ThermalSideSnapshot,
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

  it('fmtDayLabel returns weekday + day strings', () => {
    const { weekday, day } = fmtDayLabel(new Date('2026-05-31T12:00:00Z').getTime())
    expect(weekday.length).toBeGreaterThan(0)
    expect(day.length).toBeGreaterThan(0)
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

  it('fmtRel', () => {
    expect(fmtRel(null)).toBe('—')
    expect(fmtRel(new Date(Date.now() - 1000).toISOString())).toBe('past')
    expect(fmtRel(new Date(Date.now() + 30_000).toISOString())).toBe('<1m')
    expect(fmtRel(new Date(Date.now() + 5 * 60_000).toISOString())).toBe('5m')
    expect(fmtRel(new Date(Date.now() + 2 * 3_600_000 + 3 * 60_000).toISOString())).toBe('2h 3m')
    expect(fmtRel(new Date(Date.now() + 2 * 86_400_000 + 3 * 3_600_000).toISOString())).toBe('2d 3h')
  })
})

describe('jobTone', () => {
  it('maps by keyword', () => {
    expect(jobTone('temperature')).toContain('orange')
    expect(jobTone('powerOff')).toContain('zinc-600')
    expect(jobTone('powerOn')).toContain('emerald')
    expect(jobTone('alarm')).toContain('amber')
    expect(jobTone('prime')).toContain('sky')
    expect(jobTone('reboot')).toContain('purple')
    expect(jobTone('mystery')).toContain('zinc-700')
  })
})

describe('fmtJobValue', () => {
  it('prefers temperature, then brightness, else dash', () => {
    expect(fmtJobValue({ targetTempF: 82.4 })).toBe('82°F')
    expect(fmtJobValue({ brightness: 40 })).toBe('40%')
    expect(fmtJobValue({ targetTempF: 80, brightness: 40 })).toBe('80°F')
    expect(fmtJobValue({})).toBe('—')
    expect(fmtJobValue({ targetTempF: null, brightness: null })).toBe('—')
  })
})

describe('VERDICT_STYLES', () => {
  it('covers all thermal verdicts', () => {
    expect(Object.keys(VERDICT_STYLES).sort()).toEqual(['delivering', 'idle', 'off', 'stalled', 'starting'])
    expect(VERDICT_STYLES.starting.label).toBe('STARTING')
  })
})

describe('buildWeekLanes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-31T12:00:00'))
  })
  afterEach(() => vi.useRealTimers())

  function midnightToday(): number {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }

  it('buckets jobs into 7 lanes, marks today, sorts, drops out-of-range and null', () => {
    const start = midnightToday()
    const job = (id: string, offsetMs: number | null): SchedJob => ({
      id, type: 'temperature', nextRun: offsetMs == null ? null : new Date(start + offsetMs).toISOString(),
    })
    const jobs: SchedJob[] = [
      job('today-late', 20 * 3_600_000), // today 20:00
      job('today-early', 8 * 3_600_000), // today 08:00
      job('day3', 3 * 86_400_000 + 3_600_000),
      job('too-far', 8 * 86_400_000), // dropped
      job('past', -86_400_000), // dropped
      job('null', null), // skipped
    ]

    const lanes = buildWeekLanes(jobs)
    expect(lanes).toHaveLength(7)
    expect(lanes[0].isToday).toBe(true)
    expect(lanes[1].isToday).toBe(false)
    // today lane sorted ascending by time
    expect(lanes[0].jobs.map(j => j.id)).toEqual(['today-early', 'today-late'])
    expect(lanes[3].jobs.map(j => j.id)).toEqual(['day3'])
    // out-of-range and null never placed
    const allIds = lanes.flatMap(l => l.jobs.map(j => j.id))
    expect(allIds).not.toContain('too-far')
    expect(allIds).not.toContain('past')
    expect(allIds).not.toContain('null')
  })

  it('handles no jobs', () => {
    const lanes = buildWeekLanes([])
    expect(lanes.every(l => l.jobs.length === 0)).toBe(true)
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

describe('thermalTrendPoints', () => {
  const snap = (over: Partial<ThermalSideSnapshot>): ThermalSideSnapshot => ({
    side: 'left', isPowered: true, targetTempF: 80, currentTempF: 75, waterTempF: 70, ...over,
  })

  it('projects a side series and gates target on power', () => {
    const history = [
      { t: 1, sides: [snap({ side: 'left' }), snap({ side: 'right', targetTempF: 90 })] },
      { t: 2, sides: [snap({ side: 'left', isPowered: false, currentTempF: 74 })] },
    ]
    const pts = thermalTrendPoints(history, 'left')
    expect(pts).toEqual([
      { t: 1, target: 80, bed: 75, water: 70 },
      { t: 2, target: null, bed: 74, water: 70 },
    ])
  })

  it('emits nulls when the side is absent from a snapshot', () => {
    const pts = thermalTrendPoints([{ t: 5, sides: [] }], 'left')
    expect(pts).toEqual([{ t: 5, target: null, bed: null, water: null }])
  })
})
