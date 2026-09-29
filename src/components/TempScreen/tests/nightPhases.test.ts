import { describe, expect, it } from 'vitest'
import {
  fForLevel,
  formatForDisplay,
  levelForF,
  nightPhases,
  phaseShiftUpdates,
  stepForDisplay,
  templateBatch,
  templateRows,
  type ScheduleTempRow,
} from '../nightPhases'
import { skyHue, tempHue } from '@/src/lib/tempColors'

// Monday 2026-09-28 14:00 local — tonight is Monday's schedule.
const MON_14 = new Date(2026, 8, 28, 14, 0, 0)
// Tuesday 02:00 still belongs to Monday night.
const TUE_02 = new Date(2026, 8, 29, 2, 0, 0)

function curve(day: ScheduleTempRow['dayOfWeek'], idBase: number, temps = [76, 72, 74, 84]): ScheduleTempRow[] {
  const times = ['22:00', '00:00', '03:00', '06:00']
  return times.map((time, i) => ({ id: idBase + i, dayOfWeek: day, time, temperature: temps[i], enabled: true }))
}

function phasesOf(rows: ScheduleTempRow[], now: Date) {
  const p = nightPhases(rows, now)
  if (!p) throw new Error('expected phases tonight')
  return p
}

describe('Eight Sleep levels', () => {
  it('maps 0 to 82.5°F and ±10 to the 55–110°F range', () => {
    expect(fForLevel(0)).toBe(83)
    expect(fForLevel(-10)).toBe(55)
    expect(fForLevel(10)).toBe(110)
    expect(levelForF(55)).toBe(-10)
    expect(levelForF(110)).toBe(10)
  })

  it('round-trips every level through whole °F', () => {
    for (let l = -10; l <= 10; l++) expect(levelForF(fForLevel(l))).toBe(l)
  })

  it('steps one level per tap in level mode, one display degree otherwise', () => {
    expect(stepForDisplay(80, 1, 'F', 'level')).toBe(83)
    expect(stepForDisplay(80, -1, 'F', 'level')).toBe(77)
    expect(stepForDisplay(80, 1, 'F', 'degrees')).toBe(81)
    expect(stepForDisplay(80, 1, 'C', 'degrees')).toBe(82)
  })

  it('formats the big number for each display mode', () => {
    expect(formatForDisplay(77, 'F', 'degrees')).toBe('77°F')
    expect(formatForDisplay(77, 'C', 'degrees')).toBe('25°C')
    expect(formatForDisplay(77, 'F', 'offset')).toBe('−3')
    expect(formatForDisplay(88, 'F', 'level')).toBe('+2')
  })
})

describe('nightPhases', () => {
  it('returns null with no set points tonight', () => {
    expect(nightPhases(curve('tuesday', 1), MON_14)).toBeNull()
  })

  it('splits the last quarter of the night into Dawn', () => {
    const p = phasesOf(curve('monday', 1), MON_14)
    expect(p.day).toBe('monday')
    expect(p.night.times).toEqual(['22:00', '00:00', '03:00'])
    expect(p.dawn?.times).toEqual(['06:00'])
    expect(p.night.start).toBe('22:00')
    expect(p.night.end).toBe('06:00')
    // 76×120 + 72×180 + 74×180 over 480 min
    expect(p.night.temperatureF).toBeCloseTo(73.75)
    expect(p.dawn?.temperatureF).toBe(84)
  })

  it('treats early-morning hours as the previous night', () => {
    expect(nightPhases(curve('monday', 1), TUE_02)?.day).toBe('monday')
  })

  it('has no Dawn with a single set point', () => {
    const rows: ScheduleTempRow[] = [{ id: 1, dayOfWeek: 'monday', time: '22:00', temperature: 75, enabled: true }]
    const p = phasesOf(rows, MON_14)
    expect(p.night.temperatureF).toBe(75)
    expect(p.dawn).toBeNull()
  })

  it('ignores disabled rows and groups days with the identical curve', () => {
    const rows = [
      ...curve('monday', 1),
      ...curve('wednesday', 10),
      ...curve('friday', 20, [70, 70, 70, 80]),
      { id: 99, dayOfWeek: 'monday' as const, time: '04:00', temperature: 60, enabled: false },
    ]
    expect(phasesOf(rows, MON_14).days).toEqual(['monday', 'wednesday'])
  })
})

describe('phaseShiftUpdates', () => {
  it('shifts only the phase set points on the shared days, clamped to 55–110', () => {
    const rows = [...curve('monday', 1), ...curve('wednesday', 10), ...curve('friday', 20, [70, 70, 70, 80])]
    const phases = phasesOf(rows, MON_14)
    expect(phaseShiftUpdates(rows, phases, 'dawn', 30)).toEqual([
      { id: 4, temperature: 110 },
      { id: 13, temperature: 110 },
    ])
    expect(phaseShiftUpdates(rows, phases, 'night', -2).map(u => u.id)).toEqual([1, 2, 3, 10, 11, 12])
  })

  it('skips a zero delta and a missing phase', () => {
    const rows: ScheduleTempRow[] = [{ id: 1, dayOfWeek: 'monday', time: '22:00', temperature: 75, enabled: true }]
    const phases = phasesOf(rows, MON_14)
    expect(phaseShiftUpdates(rows, phases, 'night', 0)).toEqual([])
    expect(phaseShiftUpdates(rows, phases, 'dawn', 2)).toEqual([])
  })
})

describe('colors', () => {
  it('runs blue when cool, violet at neutral, rose when warm', () => {
    expect(tempHue(70)).toBe(223)
    expect(tempHue(82.5)).toBe(268)
    expect(tempHue(95)).toBe(345)
  })

  it('washes the sky indigo at night and amber-rose at dawn', () => {
    expect(skyHue(0)).toBe(235)
    expect(skyHue(390)).toBe(15)
    expect(skyHue(12 * 60)).toBe(205)
  })
})

describe('template', () => {
  it('fills only the nights without a schedule and splits into Night / Dawn', () => {
    const t = templateRows(curve('monday', 1))
    expect(new Set(t.map(r => r.dayOfWeek)).has('monday')).toBe(false)
    expect(new Set(t.map(r => r.dayOfWeek)).size).toBe(6)
    const p = phasesOf(t, new Date(2026, 8, 29, 14, 0)) // Tuesday
    expect(p.days).toHaveLength(6)
    expect(p.dawn).not.toBeNull()
  })

  it('writes the template with the chosen Night, a power window, and replaces leftovers', () => {
    const existing = {
      temperature: [{ id: 50, dayOfWeek: 'tuesday' as const, time: '23:00', temperature: 70, enabled: false }],
      power: [{ id: 7, dayOfWeek: 'tuesday' as const }, { id: 8, dayOfWeek: 'monday' as const }],
    }
    const t = templateRows([...curve('monday', 1), ...existing.temperature])
    const p = phasesOf(t, new Date(2026, 8, 29, 14, 0))
    const night = Math.round(p.night.temperatureF)
    const batch = templateBatch('left', existing, t, p, { night: night - 3 })
    expect(batch.deletes).toEqual({ temperature: [50], power: [7], alarm: [] })
    expect(batch.creates.temperature).toHaveLength(t.length)
    expect(batch.creates.power).toHaveLength(6)
    const created = batch.creates.temperature.map((r, i) => ({ ...r, id: i + 1000 }))
    expect(Math.round(phasesOf(created, new Date(2026, 8, 29, 14, 0)).night.temperatureF)).toBe(night - 3)
  })
})
