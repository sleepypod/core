import { describe, expect, it } from 'vitest'
import {
  activeCurveOn,
  daysOnSides,
  hasDays,
  type LibraryCurveClaim,
  movedDays,
  normalizeDays,
  planClaims,
  pointsToSetPoints,
  setPointsToPoints,
  uniqueCurveName,
} from './scheduleLibrary'

const curve = (id: number, name: string, days: Partial<LibraryCurveClaim['days']>, active = true): LibraryCurveClaim => ({
  id, name, days: normalizeDays(days), active,
})

describe('normalizeDays', () => {
  it('orders days by week, drops duplicates and fills missing sides', () => {
    expect(normalizeDays({ left: ['friday', 'monday', 'friday', 'sunday'] })).toEqual({ left: ['sunday', 'monday', 'friday'], right: [] })
    expect(normalizeDays(undefined)).toEqual({ left: [], right: [] })
  })
})

describe('hasDays', () => {
  it('is true when either side has a day', () => {
    expect(hasDays({ left: [], right: [] })).toBe(false)
    expect(hasDays({ left: ['monday'], right: [] })).toBe(true)
    expect(hasDays({ left: [], right: ['monday'] })).toBe(true)
  })
})

describe('daysOnSides', () => {
  it('puts the same days on the given sides only', () => {
    expect(daysOnSides(['left'], ['tuesday', 'monday'])).toEqual({ left: ['monday', 'tuesday'], right: [] })
    expect(daysOnSides(['right'], ['monday'])).toEqual({ left: [], right: ['monday'] })
    expect(daysOnSides(['left', 'right'], ['monday'])).toEqual({ left: ['monday'], right: ['monday'] })
  })
})

describe('activeCurveOn', () => {
  it('finds the active curve claiming a side and day, ignoring inactive ones and the other side', () => {
    const off = curve(1, 'Off', { left: ['monday'] }, false)
    const on = curve(2, 'On', { left: ['monday'], right: ['tuesday'] })
    expect(activeCurveOn([off, on], 'left', 'monday')).toBe(on)
    expect(activeCurveOn([off, on], 'right', 'monday')).toBeUndefined()
    expect(activeCurveOn([off, on], 'right', 'tuesday')).toBe(on)
    expect(activeCurveOn([off], 'left', 'monday')).toBeUndefined()
  })
})

describe('planClaims', () => {
  const weeknight = curve(1, 'Weeknight', { left: ['monday', 'tuesday', 'wednesday'], right: ['monday'] })
  const weekend = curve(2, 'Weekend', { left: ['saturday'] })
  const parked = curve(3, 'Parked', { left: ['monday'] }, false)

  it('moves only the overlapping days on each side and keeps the rest active', () => {
    const plan = planClaims([weeknight, weekend, parked], null, normalizeDays({ left: ['monday', 'tuesday'] }), true)
    expect(plan.updates).toEqual([{ id: 1, days: { left: ['wednesday'], right: ['monday'] }, active: true }])
    expect(plan.moves).toEqual([{ id: 1, name: 'Weeknight', side: 'left', days: ['monday', 'tuesday'], deactivated: false }])
  })

  it('reports moves per side and deactivates a curve left with no days', () => {
    const plan = planClaims([weeknight], 9, normalizeDays({
      left: ['monday', 'tuesday', 'wednesday'], right: ['monday'],
    }), true)
    expect(plan.updates).toEqual([{ id: 1, days: { left: [], right: [] }, active: false }])
    expect(plan.moves).toEqual([
      { id: 1, name: 'Weeknight', side: 'left', days: ['monday', 'tuesday', 'wednesday'], deactivated: true },
      { id: 1, name: 'Weeknight', side: 'right', days: ['monday'], deactivated: true },
    ])
  })

  it('does not take days from the other side', () => {
    const plan = planClaims([weekend], null, normalizeDays({ right: ['saturday'] }), true)
    expect(plan).toEqual({ updates: [], moves: [] })
  })

  it('moves nothing when the target ends up inactive', () => {
    expect(planClaims([weeknight], null, normalizeDays({ left: ['monday'] }), false)).toEqual({ updates: [], moves: [] })
  })

  it('never takes days from the target itself', () => {
    expect(planClaims([weeknight], 1, weeknight.days, true)).toEqual({ updates: [], moves: [] })
  })

  it('ignores inactive curves that list the same days', () => {
    expect(planClaims([parked], null, normalizeDays({ left: ['monday'] }), true)).toEqual({ updates: [], moves: [] })
  })

  it('collects moves from several curves', () => {
    const plan = planClaims([weeknight, weekend], null, normalizeDays({ left: ['monday', 'saturday'] }), true)
    expect(plan.moves.map(m => [m.name, m.days, m.deactivated])).toEqual([
      ['Weeknight', ['monday'], false],
      ['Weekend', ['saturday'], true],
    ])
  })
})

describe('movedDays', () => {
  it('drops curve ids from moves', () => {
    expect(movedDays([{ id: 4, name: 'X', side: 'right', days: ['friday'], deactivated: true }]))
      .toEqual([{ name: 'X', side: 'right', days: ['friday'], deactivated: true }])
  })
})

describe('points conversions', () => {
  it('round-trips a point map and set point list', () => {
    const points = { '22:00': 70, '06:30': 80 }
    const list = pointsToSetPoints(points)
    expect(list).toEqual([{ time: '22:00', temperature: 70 }, { time: '06:30', temperature: 80 }])
    expect(setPointsToPoints(list)).toEqual(points)
  })
})

describe('uniqueCurveName', () => {
  it('numbers taken names and keeps them within 30 characters', () => {
    expect(uniqueCurveName('Weekdays curve', new Set())).toBe('Weekdays curve')
    expect(uniqueCurveName('Weekdays curve', new Set(['Weekdays curve', 'Weekdays curve 2']))).toBe('Weekdays curve 3')
    const long = 'Mon, Tue, Wed, Thu, Fri, Sun curve'
    expect(uniqueCurveName(long, new Set())).toBe('Mon, Tue, Wed, Thu, Fri, Sun c')
    expect(uniqueCurveName(long, new Set(['Mon, Tue, Wed, Thu, Fri, Sun c']))).toBe('Mon, Tue, Wed, Thu, Fri, Sun 2')
  })
})
