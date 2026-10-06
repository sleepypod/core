/**
 * The deps module is a thin wiring layer between the GestureActionHandler
 * and the DB / shared-client singletons. The behaviour under test is "the
 * deps actually call the wired-up dependencies", so the test layer mocks
 * the imports it shouldn't pull in (DB + dacMonitor.instance) and exercises
 * each dep function.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const dbMock = vi.hoisted(() => {
  const limit = vi.fn(async () => [])
  const where = vi.fn(() => ({ limit }))
  const from = vi.fn(() => ({ where }))
  const select = vi.fn(() => ({ from }))
  return { db: { select }, select, from, where, limit }
})

const sharedClient = { connect: vi.fn() }
const sharedMock = vi.hoisted(() => ({
  getSharedHardwareClient: vi.fn(() => sharedClient),
}))

vi.mock('@/src/db', () => ({ db: dbMock.db }))
vi.mock('@/src/db/schema', () => ({
  tapGestures: { side: 'side', tapType: 'tapType' },
  deviceState: { side: 'side' },
}))
vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (col: unknown, val: unknown) => ({ eq: [col, val] }),
}))
vi.mock('@/src/hardware/dacMonitor.instance', () => sharedMock)

const alarmMock = vi.hoisted(() => ({
  getActiveAlarmConfig: vi.fn(),
  markAlarmEnded: vi.fn(),
  snoozeAlarm: vi.fn(),
  cancelSnooze: vi.fn(),
}))
vi.mock('@/src/hardware/alarmState', () => alarmMock)
vi.mock('@/src/hardware/snoozeManager', () => alarmMock)

const { defaultGestureActionDeps } = await import('@/src/hardware/gestureActionHandler.deps')

describe('defaultGestureActionDeps', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each(['left', 'right'] as const)('wires alarm actions for %s', async (side) => {
    const config = { vibrationIntensity: 65, vibrationPattern: 'double' as const, duration: 45 }
    alarmMock.getActiveAlarmConfig.mockReturnValueOnce(config).mockReturnValueOnce(null)
    const alarm = defaultGestureActionDeps.alarm
    if (!alarm) throw new Error('Missing alarm dependencies')
    expect(alarm.activeConfig(side)).toBe(config)
    expect(alarm.activeConfig(side)).toBeNull()
    expect(alarmMock.getActiveAlarmConfig).toHaveBeenCalledWith(side)

    const ended = Promise.resolve()
    alarmMock.markAlarmEnded.mockReturnValueOnce(ended)
    expect(alarm.ended(side)).toBe(ended)
    expect(alarmMock.markAlarmEnded).toHaveBeenCalledExactlyOnceWith(side)

    alarm.snooze(side, 180, config)
    await vi.dynamicImportSettled()
    expect(alarmMock.snoozeAlarm).toHaveBeenCalledExactlyOnceWith(side, 180, config)
    alarm.cancelSnooze(side)
    await vi.waitFor(() => expect(alarmMock.cancelSnooze).toHaveBeenCalledExactlyOnceWith(side))
  })

  it('findGestureConfig returns the first row or null', async () => {
    dbMock.limit.mockResolvedValueOnce([{ actionType: 'alarm' }] as never)
    expect(await defaultGestureActionDeps.findGestureConfig('left', 'doubleTap'))
      .toEqual({ actionType: 'alarm' })

    dbMock.limit.mockResolvedValueOnce([] as never)
    expect(await defaultGestureActionDeps.findGestureConfig('right', 'tripleTap'))
      .toBeNull()
  })

  it('findDeviceState returns the first row or null', async () => {
    dbMock.limit.mockResolvedValueOnce([{ isPowered: true }] as never)
    expect(await defaultGestureActionDeps.findDeviceState('left'))
      .toEqual({ isPowered: true })

    dbMock.limit.mockResolvedValueOnce([] as never)
    expect(await defaultGestureActionDeps.findDeviceState('right')).toBeNull()
  })

  it('newHardwareClient ignores the socketPath and returns the shared client', () => {
    const client = defaultGestureActionDeps.newHardwareClient('/tmp/whatever.sock')
    expect(client).toBe(sharedClient)
    expect(sharedMock.getSharedHardwareClient).toHaveBeenCalled()
  })
})
