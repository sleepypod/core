import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DacMonitor } from '@/src/hardware/dacMonitor'
import type { DeviceStatus, Side } from '@/src/hardware/types'
import { fahrenheitToLevel } from '@/src/hardware/types'
import { beginStatusChange, getStatusRevision } from '@/src/hardware/statusRevision'
import { withSideLock } from '@/src/hardware/sideLock'

const setTemperature = vi.fn(), setPower = vi.fn(), releaseHeldPowerOff = vi.fn()
const shouldBlock = vi.fn<(side: Side) => boolean>()
const reconnect = vi.fn<() => Promise<void>>()
vi.mock('@/src/temperature/instance', () => ({
  getTemperatureController: () => ({
    setManualLocked: async (side: Side, target: number, _hold?: number, _duration?: number, validate?: () => void) => {
      await reconnect()
      validate?.()
      const finish = beginStatusChange()
      try {
        await setTemperature(side, target)
      }
      finally { finish() }
    },
    powerOffLocked: async (side: Side) => {
      const finish = beginStatusChange()
      try {
        await setPower(side, false)
      }
      finally { finish() }
    },
  }),
}))
vi.mock('@/src/hardware/pumpStallGuard', () => ({ shouldBlock: (side: Side) => shouldBlock(side) }))
vi.mock('@/src/scheduler', () => ({ getJobManager: async () => ({ releaseHeldPowerOff }) }))

import { __resetSideController, getRequestedTargetF, getStagedTargetF, setSidePowerOff, setSidePowerOn, setTargetTemperature } from '../accessories/sideController'
import { THERMOSTAT_FRESH_MS } from '../accessories/reportedState'

const epoch = Date.parse('2026-10-25T12:00:00Z')
const off: DeviceStatus = {
  leftSide: { currentTemperature: 75, targetTemperature: 70, currentLevel: 0, targetLevel: 0, heatingDuration: 0 },
  rightSide: { currentTemperature: 75, targetTemperature: 75, currentLevel: 0, targetLevel: 0, heatingDuration: 0 },
  waterLevel: 'ok', isPriming: false, podVersion: 'I00' as never, sensorLabel: 'pod4',
}
const on: DeviceStatus = { ...off,
  leftSide: { ...off.leftSide, targetLevel: -45, heatingDuration: 900 },
  rightSide: { ...off.rightSide, targetLevel: 30, heatingDuration: 900 },
}

/** A fake poll captures the real process revision so intervening commands invalidate it. */
function monitor(initial: DeviceStatus | null) {
  let status = initial, observedAt = Date.now(), revision = getStatusRevision(), running = true
  const result = {
    getLastStatus: () => status,
    getLastPollAt: () => observedAt,
    getStatus: () => running ? 'running' : 'stopped',
    getFreshStatus: (maxAge: number) => running && revision !== null && revision === getStatusRevision()
      && Date.now() >= observedAt && Date.now() - observedAt < maxAge
      ? status
      : null,
    report(next: DeviceStatus) {
      status = next
      observedAt = Date.now()
      revision = getStatusRevision()
    },
    stop() { running = false },
  }
  return result as unknown as DacMonitor & Pick<typeof result, 'report' | 'stop'>
}

beforeEach(() => {
  vi.useFakeTimers().setSystemTime(epoch)
  __resetSideController()
  setTemperature.mockReset().mockResolvedValue(undefined)
  setPower.mockReset().mockResolvedValue(undefined)
  shouldBlock.mockReset().mockReturnValue(false)
  reconnect.mockReset().mockResolvedValue(undefined)
  releaseHeldPowerOff.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  __resetSideController()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('HomeKit target requests', () => {
  it.each([[-10, 55], [999, 110], [82.4, 82], [82.6, 83]])('clamps %s°F to %s°F without a neutral firmware level', async (input, expected) => {
    await setTargetTemperature(monitor(on), 'left', input)
    expect(setTemperature).toHaveBeenCalledExactlyOnceWith('left', expected)
    expect(fahrenheitToLevel(expected)).not.toBe(0)
  })
  it.each([NaN, Infinity, -Infinity])('rejects invalid target %s without poisoning the staged value', async (input) => {
    await expect(setTargetTemperature(monitor(off), 'left', input)).rejects.toMatchObject({ hapStatus: -70410 })
    expect(getRequestedTargetF('left')).toBeNull()
    expect(setTemperature).not.toHaveBeenCalled()
  })
  it('stages while OFF without hardware writes', async () => {
    const source = monitor(off)
    await setTargetTemperature(source, 'left', 68)
    expect(getStagedTargetF(source, 'left')).toBe(68)
    expect(setTemperature).not.toHaveBeenCalled()
  })
  it('does not re-power a retained target with no live countdown', async () => {
    const source = monitor({ ...on, leftSide: { ...on.leftSide, heatingDuration: 0 } })
    await setTargetTemperature(source, 'left', 72)
    expect(setTemperature).not.toHaveBeenCalled()
  })
  it.each([null, NaN, -1, 0.5])('rejects an invalid countdown %s', async (duration) => {
    const source = monitor({ ...on, leftSide: { ...on.leftSide, heatingDuration: duration as number } })
    await expect(setTargetTemperature(source, 'left', 72)).rejects.toMatchObject({ hapStatus: -70402 })
    expect(setTemperature).not.toHaveBeenCalled()
  })
  it.each([null, NaN, Infinity, 101, -101, 0.5])('rejects an invalid target level %s', async (level) => {
    const source = monitor({ ...on, leftSide: { ...on.leftSide, targetLevel: level as number } })
    await expect(setTargetTemperature(source, 'left', 72)).rejects.toMatchObject({ hapStatus: -70402 })
    expect(setTemperature).not.toHaveBeenCalled()
  })
  it('stages when the reported countdown elapsed inside the normal freshness window', async () => {
    const source = monitor({ ...on, leftSide: { ...on.leftSide, heatingDuration: 1 } })
    vi.setSystemTime(epoch + 1000)
    await setTargetTemperature(source, 'left', 72)
    expect(setTemperature).not.toHaveBeenCalled()
  })
  it('does not extend countdown evidence through a rapid slider sequence', async () => {
    const source = monitor({ ...on, leftSide: { ...on.leftSide, heatingDuration: 1 } })
    await setTargetTemperature(source, 'left', 71)
    vi.setSystemTime(epoch + 1000)
    await expect(setTargetTemperature(source, 'left', 72)).rejects.toMatchObject({ hapStatus: -70402 })
    expect(setTemperature).toHaveBeenCalledExactlyOnceWith('left', 71)
  })
  it('rejects stale ON instead of restarting heat, retaining only the requested target', async () => {
    const source = monitor(on)
    vi.setSystemTime(epoch + THERMOSTAT_FRESH_MS)
    await expect(setTargetTemperature(source, 'left', 72)).rejects.toMatchObject({ hapStatus: -70402 })
    expect(setTemperature).not.toHaveBeenCalled()
    expect(getRequestedTargetF('left')).toBe(72)
  })
  it('rejects a missing initial report', async () => {
    await expect(setTargetTemperature(monitor(null), 'left', 72)).rejects.toMatchObject({ hapStatus: -70402 })
    expect(setTemperature).not.toHaveBeenCalled()
  })
  it('uses a fresh valid target or the explicit ON default, never an old target', () => {
    const source = monitor(off)
    expect(getStagedTargetF(source, 'left')).toBe(70)
    vi.setSystemTime(epoch + THERMOSTAT_FRESH_MS)
    expect(getStagedTargetF(source, 'left')).toBe(75)
    expect(getStagedTargetF(monitor(null), 'left')).toBe(75)
    expect(getStagedTargetF(monitor({ ...off, leftSide: { ...off.leftSide, targetTemperature: NaN } }), 'left')).toBe(75)
  })
})

describe('bounded acknowledged power receipts', () => {
  it('preserves a concurrent AUTO + slider gesture before the next poll', async () => {
    const source = monitor(off)
    await Promise.all([setSidePowerOn(source, 'left'), setTargetTemperature(source, 'left', 78)])
    expect(setTemperature).toHaveBeenCalledTimes(2)
    expect(setTemperature).toHaveBeenLastCalledWith('left', 78)
    expect(releaseHeldPowerOff).toHaveBeenCalledExactlyOnceWith('left')
  })
  it('uses staged temperature for a later explicit ON even without telemetry', async () => {
    const source = monitor(off)
    await setTargetTemperature(source, 'left', 68)
    source.stop()
    await setSidePowerOn(source, 'left')
    expect(setTemperature).toHaveBeenCalledExactlyOnceWith('left', 68)
  })
  it('explicitly powers on with 75°F when no target or observation exists', async () => {
    await setSidePowerOn(monitor(null), 'right')
    expect(setTemperature).toHaveBeenCalledExactlyOnceWith('right', 75)
  })
  it.each(['expiry', 'backward clock', 'other write', 'stopped monitor'] as const)('invalidates ON authority after %s', async (reason) => {
    const source = monitor(off)
    await setSidePowerOn(source, 'left')
    setTemperature.mockClear()
    if (reason === 'expiry') vi.setSystemTime(epoch + THERMOSTAT_FRESH_MS)
    if (reason === 'backward clock') vi.setSystemTime(epoch - 1)
    if (reason === 'other write') beginStatusChange()()
    if (reason === 'stopped monitor') source.stop()
    await expect(setTargetTemperature(source, 'left', 72)).rejects.toMatchObject({ hapStatus: -70402 })
    expect(setTemperature).not.toHaveBeenCalled()
  })
  it('fresh OFF overrides an acknowledged ON, without ever needing an ON confirmation', async () => {
    const source = monitor(off)
    await setSidePowerOn(source, 'left')
    source.report(off)
    setTemperature.mockClear()
    await setTargetTemperature(source, 'left', 72)
    expect(setTemperature).not.toHaveBeenCalled()
  })
  it('rapid slider changes cannot extend the original evidence window', async () => {
    const source = monitor(on)
    await setTargetTemperature(source, 'left', 70)
    vi.setSystemTime(epoch + 10_000)
    await setTargetTemperature(source, 'left', 71)
    vi.setSystemTime(epoch + THERMOSTAT_FRESH_MS)
    await expect(setTargetTemperature(source, 'left', 72)).rejects.toMatchObject({ hapStatus: -70402 })
    expect(setTemperature).toHaveBeenCalledTimes(2)
    source.report(on)
    await setTargetTemperature(source, 'left', 72)
    expect(setTemperature).toHaveBeenCalledTimes(3)
  })
  it('does not retain ON authority after an ambiguous failure', async () => {
    const source = monitor(off)
    setTemperature.mockRejectedValueOnce(new Error('hardware down'))
    await expect(setSidePowerOn(source, 'left')).rejects.toThrow('hardware down')
    setTemperature.mockClear()
    await expect(setTargetTemperature(source, 'left', 68)).rejects.toMatchObject({ hapStatus: -70402 })
    expect(setTemperature).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith('[homekit] setPower(left, true, 70) failed:', 'hardware down')
  })
  it('does not restore old ON authority when an OFF write fails ambiguously', async () => {
    const source = monitor(off)
    await setSidePowerOn(source, 'left')
    setPower.mockRejectedValueOnce(new Error('off acknowledgment lost'))
    await expect(setSidePowerOff(source, 'left')).rejects.toThrow('off acknowledgment lost')
    setTemperature.mockClear()
    await expect(setTargetTemperature(source, 'left', 72)).rejects.toMatchObject({ hapStatus: -70402 })
    expect(setTemperature).not.toHaveBeenCalled()
  })
  it('rejects a slider while another hardware command is pending', async () => {
    const source = monitor(on), finish = beginStatusChange()
    try {
      await expect(setTargetTemperature(source, 'left', 72)).rejects.toMatchObject({ hapStatus: -70402 })
      expect(setTemperature).not.toHaveBeenCalled()
    }
    finally { finish() }
  })
  it('rechecks evidence after connection establishment before applying a target', async () => {
    const source = monitor(on)
    reconnect.mockImplementationOnce(async () => {
      beginStatusChange()()
    })
    await expect(setTargetTemperature(source, 'left', 72)).rejects.toMatchObject({ hapStatus: -70402 })
    expect(setTemperature).not.toHaveBeenCalled()
  })
})

describe('serialized writes and pump guards', () => {
  it('lets the other side proceed while a command holds the left lock', async () => {
    let release: () => void = () => {}
    const holder = withSideLock('left', () => new Promise<void>((resolve) => {
      release = resolve
    }))
    await Promise.resolve()
    const source = monitor(on)
    try {
      const left = setSidePowerOn(source, 'left')
      await setSidePowerOn(source, 'right')
      expect(setTemperature).toHaveBeenCalledExactlyOnceWith('right', 75)
      release()
      await holder
      await left
      expect(setTemperature).toHaveBeenLastCalledWith('left', 75)
    }
    finally {
      release()
      await holder
    }
  })
  it('rechecks freshness when a slider reaches the front of the queue', async () => {
    let release: () => void = () => {}
    const holder = withSideLock('left', () => new Promise<void>((resolve) => {
      release = resolve
    }))
    await Promise.resolve()
    try {
      const target = setTargetTemperature(monitor(on), 'left', 72)
      const rejected = expect(target).rejects.toMatchObject({ hapStatus: -70402 })
      vi.setSystemTime(epoch + THERMOSTAT_FRESH_MS)
      release()
      await holder
      await rejected
      expect(setTemperature).not.toHaveBeenCalled()
    }
    finally {
      release()
      await holder
    }
  })
  it('a queued OFF suppresses an earlier slider and stays available without telemetry', async () => {
    let release: () => void = () => {}
    const holder = withSideLock('left', () => new Promise<void>((resolve) => {
      release = resolve
    }))
    await Promise.resolve()
    const source = monitor(on)
    try {
      const temperature = setTargetTemperature(source, 'left', 72)
      const powerOff = setSidePowerOff(source, 'left')
      source.stop()
      shouldBlock.mockReturnValue(true)
      release()
      await holder
      await Promise.all([temperature, powerOff])
      expect(setTemperature).not.toHaveBeenCalled()
      expect(setPower).toHaveBeenCalledExactlyOnceWith('left', false)
    }
    finally {
      release()
      await holder
    }
  })
  it('rechecks the pump guard after waiting for the side lock, including concurrent ON requests', async () => {
    let release: () => void = () => {}
    const holder = withSideLock('left', () => new Promise<void>((resolve) => {
      release = resolve
    }))
    await Promise.resolve()
    const source = monitor(off)
    try {
      const requests = Promise.allSettled([setSidePowerOn(source, 'left'), setSidePowerOn(source, 'left')])
      shouldBlock.mockReturnValue(true)
      release()
      await holder
      expect(await requests).toEqual([
        { status: 'rejected', reason: expect.objectContaining({ hapStatus: -70412 }) },
        { status: 'rejected', reason: expect.objectContaining({ hapStatus: -70412 }) },
      ])
      shouldBlock.mockReturnValue(false)
      await setTargetTemperature(source, 'left', 72)
      expect(setTemperature).not.toHaveBeenCalled()
    }
    finally {
      release()
      await holder
    }
  })
  it('stages on a guard-blocked OFF side but rejects writes to a powered side', async () => {
    shouldBlock.mockImplementation(side => side === 'left')
    await setTargetTemperature(monitor(off), 'left', 66)
    await expect(setTargetTemperature(monitor(on), 'left', 68)).rejects.toMatchObject({ hapStatus: -70412 })
    expect(getRequestedTargetF('left')).toBe(68)
    expect(setTemperature).not.toHaveBeenCalled()
    await expect(setSidePowerOn(monitor(off), 'left')).rejects.toMatchObject({ hapStatus: -70412 })
    await setSidePowerOn(monitor(off), 'right')
    expect(setTemperature).toHaveBeenCalledExactlyOnceWith('right', 75)
  })
  it('recovers the queue after failure only when a new report establishes the session', async () => {
    const source = monitor(on)
    setTemperature.mockRejectedValueOnce(new Error('hardware down'))
    await expect(setTargetTemperature(source, 'left', 70)).rejects.toThrow('hardware down')
    source.report(on)
    await setTargetTemperature(source, 'left', 72)
    expect(setTemperature).toHaveBeenLastCalledWith('left', 72)
  })
})
