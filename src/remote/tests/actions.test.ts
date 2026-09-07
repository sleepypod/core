import { beforeEach, describe, expect, it, vi } from 'vitest'
import { executeRemoteAction, type RemoteActionDeps } from '../actions'
import type { Binding } from '../model'
describe('remote action dispatch', () => {
  let deps: RemoteActionDeps
  beforeEach(() => {
    deps = {
      state: vi.fn().mockResolvedValue({ targetTemperature: 70, isPowered: true, isAlarmVibrating: true }),
      away: vi.fn().mockResolvedValue(false), setTemperature: vi.fn(), setPower: vi.fn(),
      clearAlarm: vi.fn(), snoozeAlarm: vi.fn(), setAway: vi.fn(), prime: vi.fn(), runAutomation: vi.fn(),
    }
  })
  it.each<[
    Binding,
    keyof RemoteActionDeps,
    unknown[]
  ]>([
    [{ action: 'temp.up', deltaF: 2 }, 'setTemperature', ['right', 72]],
    [{ action: 'temp.down', deltaF: 3 }, 'setTemperature', ['right', 67]],
    [{ action: 'temp.preset', temperatureF: 62 }, 'setTemperature', ['right', 62]],
    [{ action: 'power.toggle' }, 'setPower', ['right', false]],
    [{ action: 'power.off' }, 'setPower', ['right', false]],
    [{ action: 'alarm.off' }, 'clearAlarm', ['right']],
    [{ action: 'alarm.snooze', durationSec: 540 }, 'snoozeAlarm', ['right', 540]],
    [{ action: 'away.toggle' }, 'setAway', ['right', true]],
    [{ action: 'prime.start' }, 'prime', []],
    [{ action: 'automation.run', automationId: 42 }, 'runAutomation', [42]],
  ])('dispatches %j through the shared control procedure', async (binding, method, args) => {
    await executeRemoteAction(binding, 'right', deps)
    expect(deps[method]).toHaveBeenCalledExactlyOnceWith(...args)
  })
  it('does not invent missing temperature or hide hardware failures', async () => {
    vi.mocked(deps.state).mockResolvedValue({ targetTemperature: null, isPowered: true, isAlarmVibrating: false })
    await expect(executeRemoteAction({ action: 'temp.up', deltaF: 1 }, 'left', deps)).rejects.toThrow('unavailable')
    expect(deps.setTemperature).not.toHaveBeenCalled()
    vi.mocked(deps.setPower).mockRejectedValue(new Error('Safety interlock'))
    await expect(executeRemoteAction({ action: 'power.off' }, 'left', deps)).rejects.toThrow('Safety interlock')
  })
  it.each([[109, 'temp.up', 110], [56, 'temp.down', 55]] as const)('clamps %s with %s to %s', async (targetTemperature, action, expected) => {
    vi.mocked(deps.state).mockResolvedValue({ targetTemperature, isPowered: true, isAlarmVibrating: false })
    await executeRemoteAction({ action, deltaF: 3 }, 'left', deps)
    expect(deps.setTemperature).toHaveBeenCalledWith('left', expected)
  })
  it('does not snooze an inactive alarm and Nothing issues no device command', async () => {
    vi.mocked(deps.state).mockResolvedValue({ targetTemperature: 70, isPowered: false, isAlarmVibrating: false })
    expect(await executeRemoteAction({ action: 'alarm.snooze', durationSec: 300 }, 'left', deps)).toContain('no active alarm')
    expect(deps.snoozeAlarm).not.toHaveBeenCalled()
    vi.clearAllMocks()
    expect(await executeRemoteAction({ action: 'none' }, 'left', deps)).toContain('native firmware remains active')
    for (const method of Object.values(deps))
      expect(method).not.toHaveBeenCalled()
  })
})
