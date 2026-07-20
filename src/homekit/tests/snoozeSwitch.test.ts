import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Characteristic } from 'hap-nodejs'

const mocks = vi.hoisted(() => ({
  clearAlarm: vi.fn().mockResolvedValue(undefined),
  snoozeAlarmFn: vi.fn(),
  cancelSnoozeFn: vi.fn(),
  state: { active: false },
}))

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getSharedHardwareClient: () => ({ clearAlarm: mocks.clearAlarm }),
}))

vi.mock('@/src/hardware/snoozeManager', () => ({
  snoozeAlarm: mocks.snoozeAlarmFn,
  cancelSnooze: mocks.cancelSnoozeFn,
  getSnoozeStatus: () => ({ active: mocks.state.active, snoozeUntil: null }),
}))

const { clearAlarm, snoozeAlarmFn: snoozeAlarm, cancelSnoozeFn: cancelSnooze, state } = mocks

import { buildSnoozeSwitch } from '../accessories/snoozeSwitch'

describe('snoozeSwitch accessory', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearAlarm.mockClear()
    snoozeAlarm.mockClear()
    cancelSnooze.mockClear()
    state.active = false
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(['left', 'right'] as const)('uses stable metadata for the %s side', (side) => {
    const { service, stop } = buildSnoozeSwitch(side)
    expect(service.displayName).toBe(`Snooze ${side}`)
    expect(service.subtype).toBe(`snooze-${side}`)
    stop()
  })

  it('on → clears alarm and registers snooze with neutral pattern', async () => {
    const { service, stop } = buildSnoozeSwitch('left')
    await service.getCharacteristic(Characteristic.On).setValue(true)
    expect(clearAlarm).toHaveBeenCalledWith('left')
    expect(snoozeAlarm).toHaveBeenCalledWith(
      'left',
      9 * 60,
      expect.objectContaining({ vibrationIntensity: 50, vibrationPattern: 'rise', duration: 60 }),
    )
    stop()
  })

  it('off → calls cancelSnooze and skips clearAlarm', async () => {
    const { service, stop } = buildSnoozeSwitch('right')
    await service.getCharacteristic(Characteristic.On).setValue(false)
    expect(cancelSnooze).toHaveBeenCalledWith('right')
    expect(clearAlarm).not.toHaveBeenCalled()
    expect(snoozeAlarm).not.toHaveBeenCalled()
    stop()
  })

  it('still registers snooze when clearAlarm fails (non-fatal)', async () => {
    clearAlarm.mockRejectedValueOnce(new Error('hardware unreachable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { service, stop } = buildSnoozeSwitch('left')
    await service.getCharacteristic(Characteristic.On).setValue(true)
    expect(snoozeAlarm).toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      '[homekit] clearAlarm(left) failed during snooze:',
      'hardware unreachable',
    )
    stop()
  })

  it('logs a raw non-Error clearAlarm failure', async () => {
    clearAlarm.mockRejectedValueOnce('plain failure')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { service, stop } = buildSnoozeSwitch('right')

    await service.getCharacteristic(Characteristic.On).handleSetRequest(true)

    expect(warn).toHaveBeenCalledWith(
      '[homekit] clearAlarm(right) failed during snooze:',
      'plain failure',
    )
    stop()
  })

  it('reports active per snoozeManager state', async () => {
    state.active = true
    const { service, stop } = buildSnoozeSwitch('left')
    expect(await service.getCharacteristic(Characteristic.On).handleGetRequest()).toBe(true)
    state.active = false
    expect(await service.getCharacteristic(Characteristic.On).handleGetRequest()).toBe(false)
    stop()
  })

  it('publishes the latest snooze state on each poll', () => {
    const { service, stop } = buildSnoozeSwitch('left')
    const update = vi.spyOn(service, 'updateCharacteristic')
    state.active = true

    vi.advanceTimersByTime(5_000)

    expect(update).toHaveBeenCalledWith(Characteristic.On, true)
    stop()
  })

  it('does not require Node-specific unref support on the poll handle', () => {
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(7 as never)
    expect(() => buildSnoozeSwitch('left')).not.toThrow()
  })

  it('stop() clears the poll interval', () => {
    const { stop } = buildSnoozeSwitch('left')
    stop()
    // Advance well past the poll interval — no errors / no leaked timers.
    vi.advanceTimersByTime(60_000)
  })
})
