import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  ringing: new Map<string, unknown>(),
  markAlarmEnded: vi.fn(async (side: string) => {
    state.ringing.delete(side)
  }),
  markAlarmStarted: vi.fn(async (side: string, config: unknown) => {
    state.ringing.set(side, config)
  }),
}))
vi.mock('../alarmState', () => ({
  getActiveAlarmConfig: (side: string) => state.ringing.get(side) ?? null,
  markAlarmEnded: state.markAlarmEnded,
  markAlarmStarted: state.markAlarmStarted,
}))

import { ringLinked, stopLinked } from '../linkedAlarm'

const base = { vibrationIntensity: 100, vibrationPattern: 'rise' as const, duration: 120 }
const owner = { ...base, ownerSide: 'left' as const, linkedSide: 'right' as const }

beforeEach(() => {
  state.ringing.clear()
  state.markAlarmEnded.mockClear()
  state.markAlarmStarted.mockClear()
})

describe('stopLinked', () => {
  it('stops the linked side ringing this alarm', async () => {
    state.ringing.set('right', { ...owner, linkedSide: 'left' })
    const client = { clearAlarm: vi.fn(async () => {}) }
    await stopLinked(client, 'left', owner)
    expect(client.clearAlarm).toHaveBeenCalledWith('right')
    expect(state.markAlarmEnded).toHaveBeenCalledWith('right')
  })

  it('leaves a different alarm ringing on the linked side alone', async () => {
    state.ringing.set('right', base)
    const client = { clearAlarm: vi.fn(async () => {}) }
    await stopLinked(client, 'left', owner)
    expect(client.clearAlarm).not.toHaveBeenCalled()
    expect(state.markAlarmEnded).not.toHaveBeenCalled()
  })

  it('keeps the linked side marked ringing when the clear fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    state.ringing.set('right', { ...owner, linkedSide: 'left' })
    const client = { clearAlarm: vi.fn(async () => {
      throw new Error('DAC write failed')
    }) }
    await stopLinked(client, 'left', owner)
    expect(state.markAlarmEnded).not.toHaveBeenCalled()
    expect(state.ringing.has('right')).toBe(true)
    error.mockRestore()
  })

  it('does nothing for an alarm without a linked side', async () => {
    const client = { clearAlarm: vi.fn(async () => {}) }
    await stopLinked(client, 'left', base)
    await stopLinked(client, 'left', null)
    expect(client.clearAlarm).not.toHaveBeenCalled()
  })
})

describe('ringLinked', () => {
  it('rings the linked side with the link pointing back', async () => {
    const client = { setAlarm: vi.fn(async () => {}) }
    await ringLinked(client, 'left', owner)
    expect(client.setAlarm).toHaveBeenCalledWith('right', { ...owner, linkedSide: 'left' })
    expect(state.markAlarmStarted).toHaveBeenCalledWith('right', { ...owner, linkedSide: 'left' })
  })
})
