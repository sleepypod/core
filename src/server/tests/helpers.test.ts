import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TRPCError } from '@trpc/server'

const hardware = vi.hoisted(() => ({
  client: {
    connect: vi.fn(),
    disconnect: vi.fn(),
  },
  getSharedHardwareClient: vi.fn(),
}))

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getSharedHardwareClient: hardware.getSharedHardwareClient,
}))

const pumpStallMock = vi.hoisted(() => ({
  shouldBlock: vi.fn<(side: 'left' | 'right') => boolean>(() => false),
}))

vi.mock('@/src/hardware/pumpStallGuard', () => pumpStallMock)

const { assertPumpStallNotBlocked, withHardwareClient } = await import('@/src/server/helpers')

beforeEach(() => {
  hardware.client.connect.mockReset().mockResolvedValue(undefined)
  hardware.client.disconnect.mockReset()
  hardware.getSharedHardwareClient.mockReset().mockReturnValue(hardware.client)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('withHardwareClient', () => {
  it('connects the singleton before invoking the callback and returns its value', async () => {
    const order: string[] = []
    hardware.client.connect.mockImplementationOnce(async () => {
      order.push('connect')
    })
    const callback = vi.fn(async () => {
      order.push('callback')
      return { ok: true }
    })

    await expect(withHardwareClient(callback, 'hardware failed')).resolves.toEqual({ ok: true })
    expect(hardware.getSharedHardwareClient).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith(hardware.client)
    expect(order).toEqual(['connect', 'callback'])
    expect(hardware.client.disconnect).not.toHaveBeenCalled()
  })

  it('does not enter the callback when the initial connection fails', async () => {
    const failure = new Error('no firmware')
    hardware.client.connect.mockRejectedValueOnce(failure)
    const callback = vi.fn()

    await expect(withHardwareClient(callback, 'hardware failed')).rejects.toBe(failure)
    expect(callback).not.toHaveBeenCalled()
  })

  it('preserves a TRPCError without reconnecting or wrapping it', async () => {
    const failure = new TRPCError({ code: 'BAD_REQUEST', message: 'invalid request' })
    const callback = vi.fn().mockRejectedValue(failure)

    await expect(withHardwareClient(callback, 'hardware failed')).rejects.toBe(failure)
    expect(callback).toHaveBeenCalledOnce()
    expect(hardware.client.disconnect).not.toHaveBeenCalled()
    expect(hardware.client.connect).toHaveBeenCalledOnce()
  })

  it.each(['socket closed', 'stream ended', 'write EPIPE', 'read ECONNRESET'])(
    'reconnects and retries once for a %s failure',
    async (message) => {
      const callback = vi.fn()
        .mockRejectedValueOnce(new Error(message))
        .mockResolvedValueOnce('retried')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      await expect(withHardwareClient(callback, 'hardware failed')).resolves.toBe('retried')
      expect(callback).toHaveBeenCalledTimes(2)
      expect(hardware.client.disconnect).toHaveBeenCalledOnce()
      expect(hardware.client.connect).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenCalledWith(`[hardware] Socket error, reconnecting: ${message}`)
      warn.mockRestore()
    },
  )

  it('wraps an Error from the retry with the operation context and cause', async () => {
    const retryFailure = new Error('second attempt failed')
    const callback = vi.fn()
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockRejectedValueOnce(retryFailure)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const error = await withHardwareClient(callback, 'Read status').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TRPCError)
    expect(error).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Read status: second attempt failed',
      cause: retryFailure,
    })
  })

  it('rethrows a TRPCError from the retry attempt instead of wrapping it as a 500', async () => {
    // e.g. the pump-stall guard trips during the reconnect window — the
    // PRECONDITION_FAILED must reach the client, not a masked 500.
    const precondition = new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Pump stall protection active — re-enable the side first',
    })
    const callback = vi.fn()
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockRejectedValueOnce(precondition)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(withHardwareClient(callback, 'hardware failed')).rejects.toBe(precondition)
    expect(callback).toHaveBeenCalledTimes(2)
  })

  it('uses the reconnect fallback for a non-Error retry rejection', async () => {
    const callback = vi.fn()
      .mockRejectedValueOnce(new Error('EPIPE'))
      .mockRejectedValueOnce('retry rejected')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const error = await withHardwareClient(callback, 'Write command').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TRPCError)
    expect(error).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Write command: Reconnect failed',
    })
  })

  it('wraps an ordinary Error without reconnecting', async () => {
    const failure = new Error('invalid response')
    const callback = vi.fn().mockRejectedValue(failure)

    await expect(withHardwareClient(callback, 'Read status')).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Read status: invalid response',
      cause: failure,
    })
    expect(hardware.client.disconnect).not.toHaveBeenCalled()
  })

  it('uses Unknown error for a non-Error initial callback rejection', async () => {
    const callback = vi.fn().mockRejectedValue({ reason: 'bad payload' })

    await expect(withHardwareClient(callback, 'Read status')).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Read status: Unknown error',
      cause: { reason: 'bad payload' },
    })
    expect(hardware.client.disconnect).not.toHaveBeenCalled()
  })
})

describe('assertPumpStallNotBlocked', () => {
  it('is a no-op when the guard does not block the side', () => {
    pumpStallMock.shouldBlock.mockReturnValueOnce(false)
    expect(() => assertPumpStallNotBlocked('left')).not.toThrow()
    expect(pumpStallMock.shouldBlock).toHaveBeenCalledWith('left')
  })

  it('throws PRECONDITION_FAILED with the guard message when blocked', () => {
    pumpStallMock.shouldBlock.mockReturnValueOnce(true)
    let caught: unknown
    try {
      assertPumpStallNotBlocked('right')
    }
    catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TRPCError)
    expect(caught).toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Pump stall protection active — re-enable the side first',
    })
  })
})
