import { describe, expect, it } from 'vitest'
import { singleSleeperSideFor } from '../singleSleeper'

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
