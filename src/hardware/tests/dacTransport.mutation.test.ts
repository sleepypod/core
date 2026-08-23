/**
 * Mutation-boundary tests for dacTransport.ts wire framing.
 *
 * `SEPARATOR` is evaluated at module load, so Stryker's static mutant on the
 * '\n\n' literal never re-runs under a cached import and reports a false
 * survivor. Re-import the module per test (vi.resetModules + dynamic import)
 * so the initializer executes with the active mutant, then pin the exact
 * bytes on the wire.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Socket } from 'net'
import { promises as fs } from 'fs'
// Type-only: erased at compile time, so the module still loads fresh per test.
import type * as DacTransportModule from '../dacTransport'

function createTestSocketPath(): string {
  return `/tmp/test-dac-mut-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`
}

function connectAsFrankenfirmware(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = new Socket()
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('Mock frankenfirmware connection timeout'))
    }, 5000)

    socket.connect(socketPath, () => {
      clearTimeout(timeout)
      resolve(socket)
    })

    socket.on('error', (err: Error) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

describe('dacTransport wire framing (fresh import per mutant)', () => {
  let socketPath = ''
  let mockFranken: Socket | undefined
  let mod: typeof DacTransportModule | undefined

  afterEach(async () => {
    try {
      mockFranken?.destroy()
      await mod?.disconnectDac()
    }
    finally {
      mockFranken = undefined
      mod = undefined
      delete process.env.DAC_MESSAGE_RESPONSE_TIMEOUT_MS
      try {
        await fs.unlink(socketPath)
      }
      catch { /* ignore */ }
    }
  })

  test('frames every outbound command with the exact double-newline separator', async () => {
    // Bound the mutant's failure mode: an unseparated request never earns a
    // response, so without this the kill would surface as a slow suite timeout.
    process.env.DAC_MESSAGE_RESPONSE_TIMEOUT_MS = '400'
    socketPath = createTestSocketPath()
    vi.resetModules()
    mod = await import('../dacTransport')

    const connectPromise = mod.connectDac(socketPath)
    await vi.waitFor(() => fs.access(socketPath), { timeout: 5_000, interval: 5 })
    mockFranken = await connectAsFrankenfirmware(socketPath)

    // Like real firmware, only a fully separator-terminated request is answered.
    const wire: string[] = []
    let buffer = ''
    mockFranken.on('data', (chunk) => {
      const text = chunk.toString('utf-8')
      wire.push(text)
      buffer += text
      while (buffer.includes('\n\n')) {
        buffer = buffer.substring(buffer.indexOf('\n\n') + 2)
        mockFranken?.write('ACK\n\n')
      }
    })

    await connectPromise

    await expect(mod.sendCommand('14')).resolves.toBe('ACK')
    expect(wire.join('')).toBe('14\n\n')

    // The argument path shares the separator; pin it too.
    await expect(mod.sendCommand('11', '-24')).resolves.toBe('ACK')
    expect(wire.join('')).toBe('14\n\n11\n-24\n\n')
  })
})
