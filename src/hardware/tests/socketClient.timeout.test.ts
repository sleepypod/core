import { afterEach, describe, expect, it, vi } from 'vitest'

const sockets = vi.hoisted(() => [] as Array<{
  connect: () => void
  destroy: () => void
}>)

vi.mock('net', async () => {
  const { EventEmitter } = await import('node:events')

  class HangingSocket extends EventEmitter {
    connect = vi.fn()
    destroy = vi.fn()

    constructor() {
      super()
      sockets.push(this)
    }
  }

  return {
    Socket: HangingSocket,
    default: { Socket: HangingSocket },
  }
})

describe('connectToSocket timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
    sockets.length = 0
    vi.resetModules()
  })

  it('destroys the socket and rejects at the exact configured deadline', async () => {
    vi.useFakeTimers()
    const { connectToSocket } = await import('../socketClient')
    const connection = connectToSocket('/never-connects.sock', 123)
    const observed = connection.catch(error => error)

    await vi.advanceTimersByTimeAsync(122)
    expect(sockets[0]?.destroy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    await expect(observed).resolves.toMatchObject({
      name: 'ConnectionTimeoutError',
      code: 'CONNECTION_TIMEOUT',
      message: 'Connection timeout after 123ms',
    })
    expect(sockets[0]?.destroy).toHaveBeenCalledOnce()
  })
})
