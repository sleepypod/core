import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withSideLock } from '../../sideLock'
import { BaseController } from '../controller'
import { BaseError, type BaseTransport } from '../types'
import { telemetry } from './fixtures'
import { installMechanicalObserver } from '@/src/biometrics/mechanical/dispatch'
import { admissionFixture } from '../../tests/admissionFixture'
import { beginHardwareWrite, captureHardwareIntent, HardwareAdmissionError } from '../../admission'
import { stopPacket } from '../protocol'

let onData: (data: Uint8Array) => void
let onDisconnect: (error: Error) => void
let controller: BaseController
let transport: BaseTransport
let now: number
const config = { Address: 'AA:BB:CC:DD:EE:FF', SplitBase: true }
const target = { head: 30, feet: 15, feedRate: 50 }
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve()
}
beforeEach(() => {
  vi.useFakeTimers()
  now = 1000
  transport = {
    connect: vi.fn(async (_config, data, disconnect) => {
      onData = data
      onDisconnect = disconnect
    }),
    write: vi.fn(async () => {}),
    close: vi.fn(),
  }
  controller = new BaseController(transport, async () => config, () => now)
})
afterEach(() => {
  controller.shutdown()
  vi.useRealTimers()
})
async function ready() {
  await controller.start()
  onData(telemetry())
}

describe('whole-bed controller', () => {
  it('blocks movement during shared quiet without disconnecting Bluetooth or disabling Stop', async () => {
    controller = new BaseController(transport, async () => config, () => now, undefined,
      () => { throw new BaseError('unavailable', 'Shared quiet is active') })
    await ready()
    await expect(controller.setPosition(target)).rejects.toThrow('Shared quiet')
    expect(transport.write).not.toHaveBeenCalled()
    expect(controller.status()).toMatchObject({ state: 'connected', busy: false })
    await controller.stop()
    expect(transport.write).toHaveBeenCalledExactlyOnceWith(stopPacket())
  })
  it('rechecks quiet after waiting for side locks and immediately before a queued write', async () => {
    let quiet = false
    controller = new BaseController(transport, async () => config, () => now, undefined, () => {
      if (quiet) throw new BaseError('unavailable', 'Shared quiet is active')
    })
    await ready()
    const release = Promise.withResolvers<undefined>()
    const held = withSideLock('left', () => release.promise)
    const result = expect(controller.setPosition(target)).rejects.toThrow('Shared quiet')
    await flush()
    quiet = true
    release.resolve(undefined)
    await held
    await result
    expect(transport.write).not.toHaveBeenCalled()
    expect(controller.status().state).toBe('connected')
  })
  it('withholds the second movement when quiet begins between head and feet writes', async () => {
    let quiet = false
    controller = new BaseController(transport, async () => config, () => now, undefined, () => {
      if (quiet) throw new BaseError('unavailable', 'Shared quiet is active')
    })
    await ready()
    const result = expect(controller.setPosition(target)).rejects.toThrow('Shared quiet')
    await flush()
    expect(transport.write).toHaveBeenCalledTimes(1)
    quiet = true
    await vi.advanceTimersByTimeAsync(500)
    await result
    expect(transport.write).toHaveBeenCalledTimes(1)
    expect(controller.status()).toMatchObject({ state: 'connected', busy: false })
    await controller.stop()
    expect(transport.write).toHaveBeenLastCalledWith(stopPacket())
  })
  it('does not report drained writes before an explicit Stop is acknowledged', async () => {
    await ready()
    const reply = Promise.withResolvers<undefined>()
    vi.mocked(transport.write).mockReturnValueOnce(reply.promise)
    const stopping = controller.stop()
    await flush()
    let drained = false
    const waiting = controller.waitForWrites().then(() => {
      drained = true
    })
    await flush()
    expect(drained).toBe(false)
    reply.resolve(undefined)
    await stopping
    await waiting
    expect(drained).toBe(true)
  })
  it('does not call the gap between head and feet commands fully drained', async () => {
    await ready()
    const moving = controller.setPosition(target)
    await flush()
    await expect(controller.waitForWrites()).rejects.toMatchObject({ code: 'busy' })
    await vi.advanceTimersByTimeAsync(500)
    await moving
    await expect(controller.waitForWrites()).resolves.toBeUndefined()
  })
  it('withdraws the delayed leg movement across arrangement revisions without closing Bluetooth or losing Stop', async () => {
    const admission = admissionFixture()
    const accepted: Uint8Array[] = []
    vi.mocked(transport.write).mockImplementation(async (packet) => {
      const finish = beginHardwareWrite(captureHardwareIntent(), Buffer.from(packet).equals(Buffer.from(stopPacket())))
      try {
        accepted.push(packet)
      }
      finally { finish() }
    })
    try {
      await ready()
      const moving = expect(controller.setPosition(target)).rejects.toThrow(HardwareAdmissionError)
      await flush()
      expect(accepted).toHaveLength(1)
      admission.set({ revision: 3, holdId: null })
      await vi.advanceTimersByTimeAsync(500)
      await moving
      expect(accepted).toHaveLength(1)
      expect(controller.status()).toMatchObject({ state: 'connected', busy: false })
      admission.set({ revision: 4, holdId: '00000000-0000-4000-8000-000000000001' })
      await controller.stop()
      expect(accepted).toHaveLength(2)
      expect(accepted[1]).toEqual(stopPacket())
    }
    finally { admission.uninstall() }
  })
  it('blocks movement when its interference record fails while preserving Stop', async () => {
    await ready()
    const command = vi.fn(() => {
      throw new Error('journal unavailable')
    })
    const uninstall = installMechanicalObserver({ command })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(controller.setPosition(target)).rejects.toThrow('journal unavailable')
      expect(transport.write).not.toHaveBeenCalled()
      await controller.stop()
      expect(transport.write).toHaveBeenCalledTimes(1)
      expect(command).toHaveBeenCalledTimes(2)
      expect(controller.status().busy).toBe(false)
    }
    finally {
      uninstall()
      warning.mockRestore()
    }
  })
  it('keeps missing configuration and unknown telemetry distinct from flat', async () => {
    const missing = new BaseController(transport, async () => {
      throw new Error('ENOENT')
    })
    await missing.start()
    expect(missing.status()).toMatchObject({ state: 'unconfigured', position: null, moving: null })
    expect(transport.connect).not.toHaveBeenCalled()
    missing.shutdown()
    await controller.start()
    expect(controller.status()).toMatchObject({ state: 'connected', stale: true, position: null })
    await expect(controller.setPosition(target)).rejects.toThrow('unavailable')
  })
  it('reports separate measurements and raw tick movement without fabricating target positions', async () => {
    await ready()
    expect(controller.status()).toMatchObject({ splitBase: true, moving: null, position: { left: { head: 1 }, right: { head: 30 } } })
    onData(telemetry([191, 24, 540, 763]))
    expect(controller.status().moving).toBe(true)
    now += 4000
    onData(telemetry([191, 24, 540, 763]))
    expect(controller.status().moving).toBe(false)
    now += 10001
    expect(controller.status()).toMatchObject({ stale: true, moving: null })
  })
  it('exposes synchronized capability and rejects one-sided writes before any transport activity', async () => {
    await ready()
    expect(controller.status().independentControl).toBe(false)
    await expect(controller.setPosition({ ...target, sides: ['left'] })).rejects.toThrow('whole-bed')
    expect(transport.write).not.toHaveBeenCalled()
  })
  it('tracks motion independently and expires both estimates with stale telemetry', async () => {
    await ready()
    onData(telemetry([191, 24, 540, 763]))
    expect(controller.status().movingBySide).toEqual({ left: true, right: false })
    now += 4000
    onData(telemetry([191, 24, 541, 763]))
    expect(controller.status().movingBySide).toEqual({ left: false, right: true })
    now += 10001
    expect(controller.status().movingBySide).toEqual({ left: null, right: null })
  })
  it('serializes torso then legs with a gap and rejects overlapping moves', async () => {
    await ready()
    const move = controller.setPosition(target)
    await flush()
    await expect(controller.setPosition(target)).rejects.toThrow('in progress')
    expect(transport.write).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    await move
    const calls = vi.mocked(transport.write).mock.calls
    expect(calls.map(([bytes]) => bytes[9])).toEqual([6, 5])
    expect(controller.status().position?.left.head).toBe(1)
  })
  it('stop during the gap cancels the second motor command', async () => {
    await ready()
    const move = controller.setPosition(target)
    const result = expect(move).rejects.toThrow('cancelled')
    await flush()
    await controller.stop()
    await vi.advanceTimersByTimeAsync(500)
    await result
    expect(vi.mocked(transport.write).mock.calls.map(([p]) => p.length)).toEqual([20, 13])
  })
  it('stop bypasses side locks and cancels a move waiting on them', async () => {
    await ready()
    let release!: () => void
    const lock = withSideLock('left', () => new Promise<void>((resolve) => {
      release = resolve
    }))
    await flush()
    const move = controller.setPosition(target)
    const result = expect(move).rejects.toThrow('cancelled')
    await controller.stop()
    expect(vi.mocked(transport.write).mock.calls[0][0].length).toBe(13)
    release()
    await lock
    await result
    expect(transport.write).toHaveBeenCalledTimes(1)
  })
  it('stop waits only for the active transport write, then blocks the leg command', async () => {
    await ready()
    let acknowledge!: () => void
    vi.mocked(transport.write).mockImplementationOnce(() => new Promise<void>((resolve) => {
      acknowledge = resolve
    }))
    const move = controller.setPosition(target)
    const result = expect(move).rejects.toThrow('cancelled')
    await flush()
    const stop = controller.stop()
    await flush()
    expect(transport.write).toHaveBeenCalledTimes(1)
    acknowledge()
    await stop
    await vi.advanceTimersByTimeAsync(500)
    await result
    expect(transport.write).toHaveBeenCalledTimes(2)
  })
  it('permits stop with stale position but blocks movement', async () => {
    await ready()
    now += 11000
    await expect(controller.setPosition(target)).rejects.toThrow('unavailable')
    await controller.stop()
    expect(transport.write).toHaveBeenCalledTimes(1)
  })
  it('does not send the second motor after telemetry expires during the gap', async () => {
    await ready()
    const move = controller.setPosition(target)
    const result = expect(move).rejects.toThrow('unavailable')
    await flush()
    now += 11000
    await vi.advanceTimersByTimeAsync(500)
    await result
    expect(transport.write).toHaveBeenCalledTimes(1)
    await controller.stop()
    expect(transport.write).toHaveBeenCalledTimes(2)
  })
  it('reconnects after disconnection without replaying movement', async () => {
    await ready()
    onDisconnect(new Error('lost connection'))
    expect(controller.status()).toMatchObject({ state: 'disconnected', stale: true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport.connect).toHaveBeenCalledTimes(2)
    expect(transport.write).not.toHaveBeenCalled()
    expect(controller.status().position).toBeNull()
  })
  it('rechecks a schedule guard within locks and between motors', async () => {
    await ready()
    const guard = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const move = controller.setPosition(target, guard)
    await vi.advanceTimersByTimeAsync(500)
    await move
    expect(guard).toHaveBeenCalledTimes(2)
    expect(transport.write).toHaveBeenCalledTimes(1)
  })
  it('shutdown prevents connection completion and retries from reviving the controller', async () => {
    let resolveConfig!: (config: unknown) => void
    controller = new BaseController(transport, () => new Promise((resolve) => {
      resolveConfig = resolve
    }))
    const start = controller.start()
    controller.shutdown()
    resolveConfig(config)
    await start
    expect(transport.connect).not.toHaveBeenCalled()
    expect(controller.status().state).toBe('disconnected')
  })
  it('write failures reject, invalidate pending movement, and do not replay', async () => {
    await ready()
    vi.mocked(transport.write).mockRejectedValueOnce(new Error('GATT rejected'))
    await expect(controller.setPosition(target)).rejects.toThrow('not confirmed')
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport.write).toHaveBeenCalledTimes(1)
    expect(controller.status().position).toBeNull()
  })
})
