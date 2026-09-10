import { describe, expect, it } from 'vitest'
import { bindingSchema, defaultBinding, describe as describeBinding, editConfig, emptyConfig, inputHint, inputLabel } from '../model'
describe('Remote mapping contract', () => {
  it('uses structured defaults and consistent descriptions for every parameter kind', () => {
    expect(defaultBinding('temp.up')).toEqual({ action: 'temp.up', deltaF: 1 })
    expect(defaultBinding('temp.down')).toEqual({ action: 'temp.down', deltaF: 1 })
    expect(defaultBinding('temp.preset')).toEqual({ action: 'temp.preset', temperatureF: 68 })
    expect(defaultBinding('alarm.snooze')).toEqual({ action: 'alarm.snooze', durationSec: 540 })
    expect(describeBinding(defaultBinding('temp.preset'))).toBe('Set temperature 68°F')
    expect(describeBinding(defaultBinding('alarm.snooze'))).toBe('Snooze alarm 9 min')
    expect(describeBinding(defaultBinding('automation.run', 42), [{ id: 42, name: 'Evening' }])).toBe('Run “Evening”')
    expect(describeBinding(defaultBinding('automation.run', 42))).toBe('Run “Deleted automation”')
    expect(describeBinding(defaultBinding('none'))).toBe('Nothing')
    expect(describeBinding(undefined)).toBe('Firmware default')
    expect(() => defaultBinding('automation.run')).toThrow()
    expect(() => defaultBinding('elev.preset')).toThrow()
  })
  it('keeps optional rows unique and cannot add duplicates of permanent inputs', () => {
    const first = editConfig(emptyConfig(), 'left', { kind: 'add', input: 'top.double' })
    const second = editConfig(first, 'left', { kind: 'add', input: 'top.double' })
    const third = editConfig(second, 'left', { kind: 'add', input: 'top.single' })
    expect(third.extras.left).toEqual(['top.double'])
    expect(third.left).toEqual({})
    expect(first.revision).toBe(1)
    expect(third.revision).toBe(3)
  })
  it('keeps the explicit handoff combo IDs and avoids an unverified double-click timing claim', () => {
    expect(inputLabel('top+mid.single')).toBe('Top + Middle')
    expect(inputHint('top+bottom.single')).toBe('T + B · together')
    expect(inputHint('mid.double')).toBe('M · 2 presses')
  })
})

describe('Direct temperature assignment', () => {
  it.each([55, 63, 71, 110])('accepts a whole-degree target of %i without an automation', (temperatureF) => {
    expect(bindingSchema.parse({ action: 'temp.preset', temperatureF })).toEqual({ action: 'temp.preset', temperatureF })
  })
  it.each([54, 111, 68.5, NaN])('rejects invalid temperature %s', (temperatureF) => {
    expect(bindingSchema.safeParse({ action: 'temp.preset', temperatureF }).success).toBe(false)
  })
})
