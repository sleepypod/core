import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withSideLock } from '../../sideLock'
import { BaseController } from '../controller'
import type { BaseTransport } from '../types'
import { telemetry } from './fixtures'

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
