import { describe, expect, it } from 'vitest'
import { activeSleeperSides, singleScheduleSideFor, mirrorSideFor, scheduleSourceSide, singleSleeperSideFor } from '../singleSleeper'

describe('singleSleeperSideFor', () => {
  it.each([
    [{ left: { awayMode: false }, right: { awayMode: true } }, 'left'],
    [{ left: { awayMode: true }, right: { awayMode: false } }, 'right'],
    [{ left: { awayMode: false }, right: { awayMode: false } }, null],
    [{ left: { awayMode: true }, right: { awayMode: true } }, null],
    [{ right: { awayMode: true } }, 'left'],
    [{ left: null, right: { awayMode: null } }, null],
    [undefined, null],
  ])('%j → %s', (sides, expected) => {
    expect(singleSleeperSideFor(sides)).toBe(expected)
  })
})

const sides = (left: boolean, right: boolean) => ({ left: { awayMode: left }, right: { awayMode: right }, unusedZoneMode: 'follow' as const })

describe('scheduleSourceSide', () => {
  it.each([
    ['left', sides(false, false), 'left'],
    ['right', sides(false, false), 'right'],
    ['left', sides(false, true), 'left'],
    // The away side of a single sleeper follows that sleeper.
    ['right', sides(false, true), 'left'],
    ['left', sides(true, false), 'right'],
    // Both away: nobody's schedule runs.
    ['left', sides(true, true), null],
    ['right', undefined, 'right'],
  ] as const)('%s with %j → %s', (side, s, expected) => {
    expect(scheduleSourceSide(side, s)).toBe(expected)
  })
})

describe('mirrorSideFor', () => {
  it.each([
    ['left', sides(false, true), 'right'],
    ['right', sides(true, false), 'left'],
    ['right', sides(false, true), null],
    ['left', sides(false, false), null],
    ['left', sides(true, true), null],
  ] as const)('%s with %j → %s', (side, s, expected) => {
    expect(mirrorSideFor(side, s)).toBe(expected)
  })
})

describe('explicit solo setup and independent zones', () => {
  it.each(['solo-left', 'solo-right'] as const)('retains %s setup while the sleeper is away and returns', (bedMode) => {
    const side = bedMode === 'solo-left' ? 'left' : 'right'
    const state = { bedMode, left: { awayMode: false }, right: { awayMode: false } }
    expect(activeSleeperSides(state)).toEqual([side])
    state[side].awayMode = true
    expect(activeSleeperSides(state)).toEqual([])
    expect(scheduleSourceSide('left', state)).toBeNull()
    expect(scheduleSourceSide('right', state)).toBeNull()
    state[side].awayMode = false
    expect(singleSleeperSideFor(state)).toBe(side)
  })

  it.each(['two', 'solo-left'] as const)('separates occupancy from all three zone policies in %s setup', (bedMode) => {
    const state = { bedMode, left: { awayMode: false }, right: { awayMode: true } }
    expect(scheduleSourceSide('right', state)).toBeNull()
    expect(scheduleSourceSide('right', { ...state, unusedZoneMode: 'follow' })).toBe('left')
    expect(scheduleSourceSide('right', { ...state, unusedZoneMode: 'independent' })).toBe('right')
    expect(singleScheduleSideFor({ ...state, unusedZoneMode: 'independent' })).toBeNull()
    expect(singleSleeperSideFor({ ...state, unusedZoneMode: 'independent' })).toBe('left')
  })
})
