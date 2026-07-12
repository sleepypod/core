import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRule, Condition, Expr } from '../types'

// The DAC monitor is mocked at the import boundary so DeviceSignalReader can be
// exercised without real hardware. `getLastStatusMock` is swapped per test.
let getLastStatusMock: () => unknown = () => null
let monitorRunning = true

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getDacMonitorIfRunning: () => (monitorRunning ? { getLastStatus: getLastStatusMock } : null),
}))

import {
  CompositeSignalReader,
  DeviceSignalReader,
  clockInTimezone,
  collectWindowSignals,
} from '../signals'

beforeEach(() => {
  getLastStatusMock = () => null
  monitorRunning = true
})

describe('clockInTimezone', () => {
  it('returns minutes-since-midnight and the weekday for a known instant', () => {
    // 2021-11-14T15:30:00Z is a Sunday; UTC keeps wall time == instant.
    const { nowMinutes, dayOfWeek } = clockInTimezone('UTC', new Date('2021-11-14T15:30:00Z'))
    expect(nowMinutes).toBe(15 * 60 + 30)
    expect(dayOfWeek).toBe('sunday')
  })

  it('shifts the wall clock into the requested timezone', () => {
    // 08:00Z in Los Angeles (UTC-8 in winter) is 00:00 local, Monday.
    const { nowMinutes, dayOfWeek } = clockInTimezone('America/Los_Angeles', new Date('2021-11-15T08:00:00Z'))
    expect(nowMinutes).toBe(0)
    expect(dayOfWeek).toBe('monday')
  })

  it('throws on an invalid timezone', () => {
    expect(() => clockInTimezone('Not/AZone', new Date())).toThrow()
  })
})

describe('DeviceSignalReader', () => {
  it('returns an empty snapshot when the monitor is not running', () => {
    monitorRunning = false
    expect(new DeviceSignalReader().read()).toEqual({})
  })

  it('returns an empty snapshot when there is no last status frame', () => {
    getLastStatusMock = () => null
    expect(new DeviceSignalReader().read()).toEqual({})
  })

  it('maps both sides plus a low water flag', () => {
    getLastStatusMock = () => ({
      leftSide: { currentTemperature: 75, targetTemperature: 80, currentLevel: 10 },
      rightSide: { currentTemperature: 70, targetTemperature: 68, currentLevel: -5 },
      waterLevel: 'low',
    })
    expect(new DeviceSignalReader().read()).toEqual({
      'left.currentTemperature': 75,
      'left.targetTemperature': 80,
      'left.currentLevel': 10,
      'right.currentTemperature': 70,
      'right.targetTemperature': 68,
      'right.currentLevel': -5,
      'water.low': 1,
    })
  })

  it('omits temperature signals for an off side reporting null level-0 temps', () => {
    getLastStatusMock = () => ({
      leftSide: { currentTemperature: null, targetTemperature: null, currentLevel: 0 },
      rightSide: { currentTemperature: 70, targetTemperature: 68, currentLevel: -5 },
      waterLevel: 'ok',
    })
    const snap = new DeviceSignalReader().read()
    // Off side: temp signals stay absent so rules don't fire on a phantom neutral.
    expect(snap['left.currentTemperature']).toBeUndefined()
    expect(snap['left.targetTemperature']).toBeUndefined()
    expect(snap['left.currentLevel']).toBe(0)
    // Powered side still maps its temps through.
    expect(snap['right.currentTemperature']).toBe(70)
    expect(snap['right.targetTemperature']).toBe(68)
  })

  it('encodes an ok water level as 0 and skips an absent side', () => {
    getLastStatusMock = () => ({
      leftSide: { currentTemperature: 72, targetTemperature: 72, currentLevel: 0 },
      rightSide: undefined,
      waterLevel: 'ok',
    })
    expect(new DeviceSignalReader().read()).toEqual({
      'left.currentTemperature': 72,
      'left.targetTemperature': 72,
      'left.currentLevel': 0,
      'water.low': 0,
    })
  })

  it('omits the water flag for an unknown water level', () => {
    getLastStatusMock = () => ({
      leftSide: { currentTemperature: 72, targetTemperature: 72, currentLevel: 0 },
      rightSide: { currentTemperature: 72, targetTemperature: 72, currentLevel: 0 },
      waterLevel: 'unknown',
    })
    expect(new DeviceSignalReader().read()['water.low']).toBeUndefined()
  })

  it('warns and degrades to an empty snapshot when the read throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getLastStatusMock = () => {
      throw new Error('frame corrupt')
    }
    expect(new DeviceSignalReader().read()).toEqual({})
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('CompositeSignalReader', () => {
  it('merges reader snapshots in order, with later readers winning collisions', () => {
    const first = { read: () => ({ 'left.movement': 1, 'water.low': 1 }) }
    const second = { read: () => ({ 'water.low': 0, 'ambient.light': 12 }) }
    expect(new CompositeSignalReader([first, second]).read()).toEqual({
      'left.movement': 1,
      'water.low': 0,
      'ambient.light': 12,
    })
  })

  it('returns an empty snapshot with no readers', () => {
    expect(new CompositeSignalReader([]).read()).toEqual({})
  })
})

describe('collectWindowSignals', () => {
  const win = (signal: string): Expr => ({ kind: 'window', fn: 'avg', signal, lastMin: 10 })
  const lit = (value: number): Expr => ({ kind: 'literal', value })

  function rule(overrides: Partial<AutomationRule>): AutomationRule {
    return {
      id: 1,
      name: 'r',
      enabled: true,
      side: 'left',
      priority: 0,
      dryRun: false,
      cooldownMin: null,
      trigger: { kind: 'tick', everyMin: 1 },
      conditions: { kind: 'and', conditions: [] },
      actions: [],
      ...overrides,
    }
  }

  it('collects window keys from nested and/or/not/compare/between conditions', () => {
    const cond: Condition = {
      kind: 'and',
      conditions: [
        { kind: 'or', conditions: [
          { kind: 'compare', op: '>', left: win('left.movement'), right: lit(200) },
        ] },
        { kind: 'not', condition: { kind: 'compare', op: '<', left: win('left.heartRate'), right: lit(50) } },
        { kind: 'between', subject: win('left.hrv'), min: lit(0), max: win('right.hrv') },
      ],
    }
    expect(collectWindowSignals([rule({ conditions: cond })])).toEqual(
      new Set(['left.movement', 'left.heartRate', 'left.hrv', 'right.hrv']),
    )
  })

  it('collects window keys from setTemperature and setPower action temps', () => {
    const rules = [rule({
      actions: [
        { kind: 'setTemperature', temp: { kind: 'clamp', value: win('ambient.temperature'), min: lit(60), max: lit(75) } },
        { kind: 'setPower', on: true, temp: win('left.breathingRate') },
      ],
    })]
    expect(collectWindowSignals(rules)).toEqual(new Set(['ambient.temperature', 'left.breathingRate']))
  })

  it('collects window keys from both operands of a binary expression', () => {
    const cond: Condition = {
      kind: 'compare',
      op: '>',
      left: { kind: 'binary', op: '-', left: win('left.surfaceTemp'), right: win('ambient.temperature') },
      right: lit(5),
    }
    expect(collectWindowSignals([rule({ conditions: cond })])).toEqual(
      new Set(['left.surfaceTemp', 'ambient.temperature']),
    )
  })

  it('ignores disabled rules', () => {
    const cond: Condition = { kind: 'compare', op: '>', left: win('left.movement'), right: lit(1) }
    expect(collectWindowSignals([rule({ enabled: false, conditions: cond })])).toEqual(new Set())
  })

  it('returns an empty set when no windows are referenced', () => {
    const cond: Condition = { kind: 'compare', op: '>', left: { kind: 'signal', signal: 'left.movement' }, right: lit(1) }
    expect(collectWindowSignals([rule({ conditions: cond })])).toEqual(new Set())
  })
})
