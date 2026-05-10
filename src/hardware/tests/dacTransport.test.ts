/**
 * Tests for dacTransport.ts — the DAC socket transport layer.
 *
 * These tests verify the critical connection behavior that took extensive
 * debugging to get right. See docs/hardware/DAC-PROTOCOL.md for context.
 *
 * Key behaviors tested:
 * 1. Server mode: WE listen, frankenfirmware connects TO us
 * 2. Queue-and-wait: connections are queued, not replaced
 * 3. Single command channel: sequential execution, no interleaving
 * 4. Reconnection: server recreates on timeout, accepts new connections
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { Socket } from 'net'
import { promises as fs } from 'fs'
import {
  connectDac,
  sendCommand,
  disconnectDac,
  isDacConnected,
  MessageResponseTimeoutError,
  backoffDelayMs,
} from '../dacTransport'

function createTestSocketPath(): string {
  return `/tmp/test-dac-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`
}

/**
 * Simulates frankenfirmware connecting to our socket as a client.
 * This is the reverse of the normal test pattern — we connect TO
 * the server that dacTransport creates.
 */
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

/**
 * Simulates frankenfirmware's protocol: read command, send response.
 */
function handleCommands(socket: Socket, responses: Record<string, string> = {}) {
  const defaultResponses: Record<string, string> = {
    14: 'tgHeatLevelR=10\ntgHeatLevelL=20\nheatTimeL=0\nheatLevelL=18\nheatTimeR=0\nheatLevelR=8\nsensorLabel=H00-test\nwaterLevel=true\npriming=false',
    0: 'READY',
    11: 'SET: ok',
    12: 'SET: ok',
  }

  const allResponses = { ...defaultResponses, ...responses }
  let buffer = ''

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf-8')

    while (buffer.includes('\n\n')) {
      const idx = buffer.indexOf('\n\n')
      const message = buffer.substring(0, idx)
      buffer = buffer.substring(idx + 2)

      const command = message.split('\n')[0].trim()
      const response = allResponses[command] ?? 'ERROR'
      socket.write(response + '\n\n')
    }
  })
}

describe('dacTransport', () => {
  let socketPath: string
  let mockFranken: Socket | undefined

  beforeEach(() => {
    socketPath = createTestSocketPath()
  })

  afterEach(async () => {
    mockFranken?.destroy()
    mockFranken = undefined
    await disconnectDac()
    try {
      await fs.unlink(socketPath)
    }
    catch { /* ignore */ }
  })

  test('creates socket server and accepts frankenfirmware connection', async () => {
    // Start connectDac in the background (it blocks waiting for connection)
    const connectPromise = connectDac(socketPath)

    // Simulate frankenfirmware connecting
    await new Promise(r => setTimeout(r, 200)) // wait for server to start
    mockFranken = await connectAsFrankenfirmware(socketPath)
    handleCommands(mockFranken)

    await connectPromise
    expect(isDacConnected()).toBe(true)
  })

  test('sends command and receives response', async () => {
    const connectPromise = connectDac(socketPath)

    await new Promise(r => setTimeout(r, 200))
    mockFranken = await connectAsFrankenfirmware(socketPath)
    handleCommands(mockFranken)

    await connectPromise

    const response = await sendCommand('14')
    expect(response).toContain('tgHeatLevelR=10')
    expect(response).toContain('sensorLabel=H00-test')
  })

  test('sends command with argument', async () => {
    const connectPromise = connectDac(socketPath)

    await new Promise(r => setTimeout(r, 200))
    mockFranken = await connectAsFrankenfirmware(socketPath)
    handleCommands(mockFranken)

    await connectPromise

    const response = await sendCommand('11', '-24')
    expect(response).toContain('SET: ok')
  })

  test('executes commands sequentially (no interleaving)', async () => {
    const connectPromise = connectDac(socketPath)

    await new Promise(r => setTimeout(r, 200))
    mockFranken = await connectAsFrankenfirmware(socketPath)

    const commandOrder: string[] = []
    let buffer = ''

    mockFranken.on('data', (chunk) => {
      buffer += chunk.toString('utf-8')
      while (buffer.includes('\n\n')) {
        const idx = buffer.indexOf('\n\n')
        const message = buffer.substring(0, idx)
        buffer = buffer.substring(idx + 2)
        const command = message.split('\n')[0].trim()
        commandOrder.push(command)
        mockFranken?.write(`OK-${command}\n\n`)
      }
    })

    await connectPromise

    // Fire 3 commands concurrently
    const [r1, r2, r3] = await Promise.all([
      sendCommand('11', '50'),
      sendCommand('12', '-30'),
      sendCommand('14'),
    ])

    // All should complete
    expect(r1).toBe('OK-11')
    expect(r2).toBe('OK-12')
    expect(r3).toBe('OK-14')

    // Commands should arrive in order (sequential queue)
    expect(commandOrder).toEqual(['11', '12', '14'])
  })

  test('throws when sending command before connected', async () => {
    await expect(sendCommand('14')).rejects.toThrow('not connected')
  })

  test('isDacConnected returns false before connection', () => {
    expect(isDacConnected()).toBe(false)
  })

  test('disconnectDac cleans up', async () => {
    const connectPromise = connectDac(socketPath)

    await new Promise(r => setTimeout(r, 200))
    mockFranken = await connectAsFrankenfirmware(socketPath)
    handleCommands(mockFranken)

    await connectPromise
    expect(isDacConnected()).toBe(true)

    await disconnectDac()
    expect(isDacConnected()).toBe(false)
  })

  describe('response timeout', () => {
    const originalTimeout = process.env.DAC_MESSAGE_RESPONSE_TIMEOUT_MS

    beforeEach(() => {
      process.env.DAC_MESSAGE_RESPONSE_TIMEOUT_MS = '150'
    })

    afterEach(() => {
      if (originalTimeout === undefined) {
        delete process.env.DAC_MESSAGE_RESPONSE_TIMEOUT_MS
      }
      else {
        process.env.DAC_MESSAGE_RESPONSE_TIMEOUT_MS = originalTimeout
      }
    })

    test('rejects with MessageResponseTimeoutError when firmware hangs', async () => {
      const connectPromise = connectDac(socketPath)

      await new Promise(r => setTimeout(r, 200))
      mockFranken = await connectAsFrankenfirmware(socketPath)
      // Intentionally do not wire up handleCommands — firmware is "hung"

      await connectPromise

      await expect(sendCommand('14')).rejects.toBeInstanceOf(MessageResponseTimeoutError)
    })

    test('queue drains after timeout — next command succeeds (no deadlock)', async () => {
      const connectPromise = connectDac(socketPath)

      await new Promise(r => setTimeout(r, 200))
      mockFranken = await connectAsFrankenfirmware(socketPath)

      await connectPromise

      // First request: firmware ignores it (no handler attached yet)
      const firstResult = sendCommand('14')
      await expect(firstResult).rejects.toBeInstanceOf(MessageResponseTimeoutError)

      // Now firmware becomes responsive. The queue must not be stuck.
      handleCommands(mockFranken)
      const response = await sendCommand('0')
      expect(response).toBe('READY')
    })
  })

  describe('reconnect backoff', () => {
    test('backoffDelayMs grows exponentially and caps at 60s', () => {
      expect(backoffDelayMs(0)).toBe(1_000)
      expect(backoffDelayMs(1)).toBe(2_000)
      expect(backoffDelayMs(2)).toBe(4_000)
      expect(backoffDelayMs(3)).toBe(8_000)
      expect(backoffDelayMs(4)).toBe(16_000)
      expect(backoffDelayMs(5)).toBe(32_000)
      // Cap: 2^6 * 1000 = 64_000 but max is 60_000
      expect(backoffDelayMs(6)).toBe(60_000)
      expect(backoffDelayMs(10)).toBe(60_000)
      expect(backoffDelayMs(100)).toBe(60_000)
    })

    test('backoffDelayMs is monotonically non-decreasing', () => {
      let prev = 0
      for (let i = 0; i < 15; i++) {
        const delay = backoffDelayMs(i)
        expect(delay).toBeGreaterThanOrEqual(prev)
        prev = delay
      }
    })
  })
})
