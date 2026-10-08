import { describe, expect, it } from 'vitest'
import { STAGE, clampTargetF, dragTargetF, formatStageTemp, sideStatus, tempColor, tempRgb } from '../stageColors'

describe('temperature ramp', () => {
  it('hits the three stops exactly and clamps beyond them', () => {
    expect(tempRgb(64)).toEqual([60, 105, 165])
    expect(tempRgb(80.5)).toEqual([78, 82, 92])
    expect(tempRgb(97)).toEqual([180, 108, 60])
    expect(tempRgb(40)).toEqual([60, 105, 165])
    expect(tempRgb(120)).toEqual([180, 108, 60])
  })
  it('is linear between stops and grey without a reading', () => {
    expect(tempRgb(72.25)).toEqual([69, 94, 129])
    expect(tempRgb(null)).toEqual([78, 82, 92])
    expect(tempRgb(Number.NaN)).toEqual([78, 82, 92])
    expect(tempColor(97)).toBe('rgb(180,108,60)')
  })
})

describe('side status', () => {
  it('reads OFF, HOLDING within half a degree, else COOLING or WARMING', () => {
    expect(sideStatus({ on: false, targetF: 72, bedF: 80 }, 'F', 'degrees').text).toBe('OFF')
    expect(sideStatus({ on: true, targetF: 72, bedF: 72.4 }, 'F', 'degrees').text).toBe('HOLDING')
    expect(sideStatus({ on: true, targetF: 72, bedF: null }, 'F', 'degrees').word).toBe('HOLDING')
    expect(sideStatus({ on: true, targetF: 72, bedF: 80 }, 'F', 'degrees')).toEqual({ word: 'COOLING', text: 'COOLING', color: STAGE.cooling })
    expect(sideStatus({ on: true, targetF: 90, bedF: 80 }, 'F', 'degrees')).toEqual({ word: 'WARMING', text: 'WARMING', color: STAGE.warming })
  })
  it('describes the schedule while previewing, in the temperature colour', () => {
    expect(sideStatus({ on: true, targetF: 72, bedF: 80 }, 'F', 'degrees', 79)).toEqual({ word: 'SCHEDULED', text: 'SCHEDULED 79°', color: tempColor(79) })
    expect(sideStatus({ on: true, targetF: 72, bedF: 80 }, 'C', 'degrees', 79).text).toBe('SCHEDULED 26°')
    expect(sideStatus({ on: true, targetF: 72, bedF: 80 }, 'F', 'degrees', null).text).toBe('OFF')
  })
})

describe('formatting and drag', () => {
  it('formats degrees in the unit, offsets from 80°F and Eight Sleep levels', () => {
    expect(formatStageTemp(72, 'F', 'degrees')).toBe('72°')
    expect(formatStageTemp(72, 'C', 'degrees')).toBe('22°')
    expect(formatStageTemp(83, 'F', 'offset')).toBe('+3')
    expect(formatStageTemp(77, 'F', 'offset')).toBe('−3')
    expect(formatStageTemp(80, 'F', 'offset')).toBe('0')
    expect(formatStageTemp(88, 'F', 'level')).toBe('+2')
    expect(formatStageTemp(null, 'F', 'degrees')).toBe('—')
  })
  it('turns vertical drag into whole degrees, up is warmer, clamped to the pod range', () => {
    expect(dragTargetF(72, -14)).toBe(73)
    expect(dragTargetF(72, 28)).toBe(70)
    expect(dragTargetF(72, 6)).toBe(72)
    expect(dragTargetF(108, -100)).toBe(110)
    expect(clampTargetF(10)).toBe(55)
  })
})
