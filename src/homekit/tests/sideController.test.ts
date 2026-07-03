import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setTemperature = vi.fn()
const setPower = vi.fn()
const registerManualOverride = vi.fn()

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getSharedHardwareClient: () => ({ setTemperature, setPower }),
}))
vi.mock('@/src/automation', () => ({
  getAutomationEngineIfRunning: () => ({ registerManualOverride }),
}))

import {
  __resetSideController,
  getStagedTargetF,
  isCurrentlyPowered,
  isEffectivelyPowered,
  isPoweredFromStatus,
  reconcileIntendedPower,
  setSidePowerOff,
  setSidePowerOn,
  setTargetTemperature,
} from '../accessories/sideController'
import type { DacMonitor } from '@/src/hardware/dacMonitor'
import type { DeviceStatus } from '@/src/hardware/types'

const offStatus: DeviceStatus = {
  leftSide: { currentTemperature: 75, targetTemperature: 70, currentLevel: 0, targetLevel: 0, heatingDuration: 0 },
  rightSide: { currentTemperature: 75, targetTemperature: 75, currentLevel: 0, targetLevel: 0, heatingDuration: 0 },
  waterLevel: 'ok',
  isPriming: false,
  podVersion: 'I00' as never,
  sensorLabel: 'pod4',
}

const onStatus: DeviceStatus = {
  ...offStatus,
  leftSide: { ...offStatus.leftSide, targetLevel: -45 },
  rightSide: { ...offStatus.rightSide, targetLevel: 30 },
}

const monitor = (status: DeviceStatus | null): DacMonitor =>
  ({ getLastStatus: () => status }) as unknown as DacMonitor

describe('sideController', () => {
  beforeEach(() => {
    __resetSideController()
    setTemperature.mockReset()
    setPower.mockReset()
    registerManualOverride.mockReset()
    setTemperature.mockResolvedValue(undefined)
    setPower.mockResolvedValue(undefined)
  })

  afterEach(() => {
    __resetSideController()
  })

  describe('isPoweredFromStatus / isCurrentlyPowered', () => {
    it('treats targetLevel === 0 as off and non-zero as on', () => {
      expect(isPoweredFromStatus(offStatus, 'left')).toBe(false)
      expect(isPoweredFromStatus(onStatus, 'left')).toBe(true)
      expect(isPoweredFromStatus(onStatus, 'right')).toBe(true)
    })

    it('returns false when monitor has no status yet', () => {
      expect(isCurrentlyPowered(monitor(null), 'left')).toBe(false)
    })
  })

  describe('isEffectivelyPowered', () => {
    it('mirrors firmware status when no write has happened yet', () => {
      expect(isEffectivelyPowered(monitor(onStatus), 'left')).toBe(true)
      expect(isEffectivelyPowered(monitor(offStatus), 'left')).toBe(false)
    })

    it('reports user intent immediately after a power-on, ahead of firmware lag', async () => {
      // Side's firmware status still says OFF until the next poll runs.
      await setSidePowerOn(monitor(offStatus), 'left')
      expect(isEffectivelyPowered(monitor(offStatus), 'left')).toBe(true)
    })

    it('reports user intent immediately after a power-off, ahead of firmware lag', async () => {
      await setSidePowerOff(monitor(onStatus), 'left')
      expect(isEffectivelyPowered(monitor(onStatus), 'left')).toBe(false)
    })
  })

  describe('getStagedTargetF', () => {
    it('falls back to firmware targetTemperature when cache is empty', () => {
      expect(getStagedTargetF(monitor(offStatus), 'left')).toBe(70)
      expect(getStagedTargetF(monitor(offStatus), 'right')).toBe(75)
    })

    it('falls back to TEMP_NEUTRAL when monitor has no status', () => {
      // TEMP_NEUTRAL = 82.5
      expect(getStagedTargetF(monitor(null), 'left')).toBe(82.5)
    })

    it('falls back to TEMP_NEUTRAL when firmware reports a null (off) target', () => {
      // Status exists but the off side reports a null level-0 target; with no
      // cache the staged target must land on neutral, not null.
      const offNullTarget = monitor({
        ...offStatus,
        leftSide: { ...offStatus.leftSide, targetTemperature: null },
      })
      expect(getStagedTargetF(offNullTarget, 'left')).toBe(82.5)
    })

    it('prefers cached target once setTargetTemperature runs', async () => {
      const m = monitor(onStatus)
      await setTargetTemperature(m, 'left', 68)
      expect(getStagedTargetF(m, 'left')).toBe(68)
    })

    it('prefers cache even after firmware reports a different value', async () => {
      // User typed 65; later poll shows firmware reset target to 82.5 while off.
      // Without the cache, a power-on would land on neutral instead of 65.
      await setTargetTemperature(monitor(onStatus), 'left', 65)
      expect(getStagedTargetF(monitor({
        ...offStatus,
        leftSide: { ...offStatus.leftSide, targetTemperature: 82.5, targetLevel: 0 },
      }), 'left')).toBe(65)
    })
  })

  describe('setTargetTemperature', () => {
    it('clamps below MIN_TEMP up to 55°F before pushing', async () => {
      await setTargetTemperature(monitor(onStatus), 'left', -10)
      expect(setTemperature).toHaveBeenCalledWith('left', 55)
    })

    it('clamps above MAX_TEMP down to 110°F before pushing', async () => {
      await setTargetTemperature(monitor(onStatus), 'left', 999)
      expect(setTemperature).toHaveBeenCalledWith('left', 110)
    })

    it('caches the requested target even when the side is off (no firmware write)', async () => {
      await setTargetTemperature(monitor(offStatus), 'left', 68)
      expect(setTemperature).not.toHaveBeenCalled()
      expect(registerManualOverride).not.toHaveBeenCalled()
      expect(getStagedTargetF(monitor(offStatus), 'left')).toBe(68)
    })

    it('caches AND writes when the side is on', async () => {
      await setTargetTemperature(monitor(onStatus), 'left', 72)
      expect(setTemperature).toHaveBeenCalledWith('left', 72)
      expect(registerManualOverride).toHaveBeenCalledWith('left')
      expect(getStagedTargetF(monitor(onStatus), 'left')).toBe(72)
    })
  })

  describe('setSidePowerOn', () => {
    it('reads cached target when present', async () => {
      const m = monitor(offStatus)
      await setTargetTemperature(m, 'left', 68)
      await setSidePowerOn(m, 'left')
      expect(setPower).toHaveBeenCalledWith('left', true, 68)
      expect(registerManualOverride).toHaveBeenCalledWith('left')
    })

    it('falls back to firmware status target when no cache exists', async () => {
      await setSidePowerOn(monitor(offStatus), 'right')
      expect(setPower).toHaveBeenCalledWith('right', true, 75)
    })

    it('falls back to TEMP_NEUTRAL when no status and no cache', async () => {
      await setSidePowerOn(monitor(null), 'left')
      expect(setPower).toHaveBeenCalledWith('left', true, 82.5)
    })
  })

  describe('setSidePowerOff', () => {
    it('routes to setPower(side, false)', async () => {
      await setSidePowerOff(monitor(onStatus), 'left')
      expect(setPower).toHaveBeenCalledWith('left', false)
      expect(registerManualOverride).toHaveBeenCalledWith('left')
    })
  })

  describe('serialization', () => {
    it('serializes concurrent writes to the same side in submission order', async () => {
      const order: string[] = []
      let resolveTemp: () => void = () => {}
      setTemperature.mockImplementation(async (_s, f) => {
        order.push(`setTemp(${f})`)
        if (f === 78) {
          await new Promise<void>((r) => {
            resolveTemp = r
          })
        }
      })
      setPower.mockImplementation(async (_s, on, f) => {
        order.push(`setPower(${on},${f ?? '-'})`)
      })

      const m = monitor(onStatus)
      // Start a slow setTemperature write...
      const p1 = setTargetTemperature(m, 'left', 78)
      // ...then immediately queue a power-on. Must NOT run before p1's await resolves.
      const p2 = setSidePowerOn(m, 'left')

      // Give microtasks a chance — p2's body should still be blocked behind p1.
      await Promise.resolve()
      await Promise.resolve()
      expect(order).toEqual(['setTemp(78)'])

      resolveTemp()
      await Promise.all([p1, p2])

      // p2 reads cache populated by p1 (78), so power-on uses the latest target.
      expect(order).toEqual(['setTemp(78)', 'setPower(true,78)'])
    })

    it('does not block a different side', async () => {
      const order: string[] = []
      let resolveLeft: () => void = () => {}
      setTemperature.mockImplementation(async (s, f) => {
        order.push(`${s}:${f}`)
        if (s === 'left') {
          await new Promise<void>((r) => {
            resolveLeft = r
          })
        }
      })

      const m = monitor(onStatus)
      const left = setTargetTemperature(m, 'left', 60)
      const right = setTargetTemperature(m, 'right', 90)

      await right // right resolves without waiting on left
      expect(order).toEqual(['left:60', 'right:90'])

      resolveLeft()
      await left
    })

    it('does not wedge the queue when a write rejects', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      setTemperature.mockRejectedValueOnce(new Error('hardware down'))
      const m = monitor(onStatus)
      await expect(setTargetTemperature(m, 'left', 70)).rejects.toThrow('hardware down')
      setTemperature.mockResolvedValueOnce(undefined)
      await setTargetTemperature(m, 'left', 72)
      expect(setTemperature).toHaveBeenLastCalledWith('left', 72)
      warn.mockRestore()
    })

    it('a queued setTemperature still runs when a power-on toggle preceded it on a previously-off side', async () => {
      // Race regression: side starts OFF. User toggles AUTO and drags the
      // slider. Without intendedPower, setTargetTemperature evaluates power
      // state from the still-stale firmware status ("off") and silently
      // skips — losing the user's setpoint. intendedPower must override
      // firmware lag so the queued setTemperature fires anyway.
      const m = monitor(offStatus)
      const p1 = setSidePowerOn(m, 'left')
      const p2 = setTargetTemperature(m, 'left', 78)
      await Promise.all([p1, p2])
      // Both surfaces must have reached the hardware. Exact setPower target
      // depends on microtask interleaving (cache may already hold 78 by the
      // time setSidePowerOn's fn runs); what matters is setTemperature(78)
      // was NOT silently dropped.
      expect(setPower).toHaveBeenCalledWith('left', true, expect.any(Number))
      expect(setTemperature).toHaveBeenCalledWith('left', 78)
    })
  })

  describe('error logging', () => {
    it('logs and rethrows when setTemperature rejects', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      setTemperature.mockRejectedValueOnce(new Error('boom'))
      await expect(setTargetTemperature(monitor(onStatus), 'left', 70)).rejects.toThrow('boom')
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[homekit] setTemperature(left, 70) failed:'),
        'boom',
      )
      warn.mockRestore()
    })

    it('logs and rethrows when setPower rejects', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      setPower.mockRejectedValueOnce(new Error('comms'))
      await expect(setSidePowerOff(monitor(onStatus), 'right')).rejects.toThrow('comms')
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[homekit] setPower(right, false) failed:'),
        'comms',
      )
      warn.mockRestore()
    })
  })

  describe('reconcileIntendedPower', () => {
    it('clears the latch once firmware confirms the intent, so external power changes show through', async () => {
      // HomeKit turns the side on; latch reports ON ahead of firmware.
      await setSidePowerOn(monitor(offStatus), 'left')
      expect(isEffectivelyPowered(monitor(offStatus), 'left')).toBe(true)

      // Firmware catches up and confirms ON → latch cleared.
      reconcileIntendedPower(onStatus, 'left')

      // Scheduler later powers the side off. Without reconciliation the
      // stale ON latch shadowed this forever.
      expect(isEffectivelyPowered(monitor(offStatus), 'left')).toBe(false)
    })

    it('keeps the latch while firmware still reports the pre-write state', async () => {
      await setSidePowerOn(monitor(offStatus), 'left')

      // Status still shows OFF (write in flight) → latch must survive.
      reconcileIntendedPower(offStatus, 'left')
      expect(isEffectivelyPowered(monitor(offStatus), 'left')).toBe(true)
    })

    it('after reconciliation, setTargetTemperature no longer re-heats a scheduler-stopped side', async () => {
      await setSidePowerOn(monitor(offStatus), 'left')
      reconcileIntendedPower(onStatus, 'left') // firmware confirmed ON
      setTemperature.mockClear()
      setPower.mockClear()

      // Scheduler turns the side off; firmware now reports OFF.
      await setTargetTemperature(monitor(offStatus), 'left', 68)
      expect(setTemperature).not.toHaveBeenCalled()
    })

    it('is a no-op when no intent is latched', () => {
      expect(() => reconcileIntendedPower(onStatus, 'left')).not.toThrow()
      expect(isEffectivelyPowered(monitor(offStatus), 'left')).toBe(false)
    })
  })

  describe('intendedPower rollback', () => {
    it('reverts intendedPower when setSidePowerOn rejects so a later setTargetTemperature does not push to a still-off side', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // Side starts off (intendedPower=null, firmware=off).
      const m = monitor(offStatus)
      setPower.mockRejectedValueOnce(new Error('hardware down'))
      await expect(setSidePowerOn(m, 'left')).rejects.toThrow('hardware down')

      // intendedPower must have rolled back to null/false. Adjusting target
      // now should NOT push to firmware (side is genuinely off).
      await setTargetTemperature(m, 'left', 68)
      expect(setTemperature).not.toHaveBeenCalled()
      warn.mockRestore()
    })

    it('reverts intendedPower when setSidePowerOff rejects', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // Side is on (intendedPower=true after a successful power-on).
      await setSidePowerOn(monitor(onStatus), 'left')
      expect(setPower).toHaveBeenCalledWith('left', true, expect.any(Number))
      setPower.mockClear()

      setPower.mockRejectedValueOnce(new Error('hardware down'))
      await expect(setSidePowerOff(monitor(onStatus), 'left')).rejects.toThrow('hardware down')

      // intendedPower must remain true so a slider drag still pushes through.
      await setTargetTemperature(monitor(onStatus), 'left', 72)
      expect(setTemperature).toHaveBeenCalledWith('left', 72)
      warn.mockRestore()
    })
  })
})
