import { describe, it, expect, beforeEach } from 'vitest'
import {
  clearPumpStallNotice,
  getAllPumpStallNotices,
  getPumpStallNotice,
  resetPumpStallNotifications,
  setPumpStallNotice,
} from '../pumpStallNotification'

describe('pumpStallNotification', () => {
  beforeEach(() => {
    resetPumpStallNotifications()
  })

  it('returns null per side initially', () => {
    expect(getPumpStallNotice('left')).toBeNull()
    expect(getPumpStallNotice('right')).toBeNull()
  })

  it('tracks set/get per side independently', () => {
    const noticeL = {
      alertId: 7,
      trippedAt: 1700000000,
      rpm: 120,
      restore: { targetTemperature: 75, durationSeconds: 28800 },
    }
    setPumpStallNotice('left', noticeL)
    expect(getPumpStallNotice('left')).toEqual(noticeL)
    expect(getPumpStallNotice('right')).toBeNull()
  })

  it('getAllPumpStallNotices returns both sides', () => {
    setPumpStallNotice('right', {
      alertId: 3,
      trippedAt: 1700000001,
      rpm: 0,
      restore: null,
    })
    const all = getAllPumpStallNotices()
    expect(all.left).toBeNull()
    expect(all.right?.alertId).toBe(3)
  })

  it('clearPumpStallNotice clears one side only', () => {
    setPumpStallNotice('left', { alertId: 1, trippedAt: 0, rpm: 0, restore: null })
    setPumpStallNotice('right', { alertId: 2, trippedAt: 0, rpm: 0, restore: null })
    clearPumpStallNotice('left')
    expect(getPumpStallNotice('left')).toBeNull()
    expect(getPumpStallNotice('right')).not.toBeNull()
  })

  it('resetPumpStallNotifications clears both sides', () => {
    setPumpStallNotice('left', { alertId: 1, trippedAt: 0, rpm: 0, restore: null })
    setPumpStallNotice('right', { alertId: 2, trippedAt: 0, rpm: 0, restore: null })
    resetPumpStallNotifications()
    expect(getPumpStallNotice('left')).toBeNull()
    expect(getPumpStallNotice('right')).toBeNull()
  })
})
