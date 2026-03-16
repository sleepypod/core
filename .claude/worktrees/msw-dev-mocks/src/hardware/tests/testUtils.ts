/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach } from 'vitest'
import { HardwareClient } from '../client'
import { type SocketClient, connectToSocket } from '../socketClient'
import { MockHardwareServer, createTestSocketPath } from './mockServer'

/**
 * Test context provided by setupMockServer.
 * Contains references to mock server and connected clients.
 */
export interface TestContext {
  server: MockHardwareServer
  socketPath: string
  socketClient?: SocketClient
  hardwareClient?: HardwareClient
}

/**
 * Sets up a mock hardware server for testing.
 * Automatically starts the server before each test and cleans up after.
 *
 * Usage:
 * ```typescript
 * describe('my tests', () => {
 *   const ctx = setupMockServer()
 *
 *   test('something', async () => {
 *     await ctx.hardwareClient.getDeviceStatus()
 *   })
 * })
 * ```
 */
export function setupMockServer(options: {
  createSocketClient?: boolean
  createHardwareClient?: boolean
} = {}): TestContext {
  const ctx: TestContext = {
    server: null!,
    socketPath: '',
  }

  beforeEach(async () => {
    ctx.socketPath = createTestSocketPath()
    ctx.server = new MockHardwareServer(ctx.socketPath)
    await ctx.server.start()

    if (options.createSocketClient) {
      ctx.socketClient = await connectToSocket(ctx.socketPath, 1000)
    }

    if (options.createHardwareClient) {
      ctx.hardwareClient = new HardwareClient({
        socketPath: ctx.socketPath,
        connectionTimeout: 1000,
        autoReconnect: false,
      })
      await ctx.hardwareClient.connect()
    }
  })

  afterEach(async () => {
    // Reset server state before cleanup
    if (ctx.server) {
      ctx.server.reset()
    }

    if (ctx.socketClient) {
      ctx.socketClient.close()
    }

    if (ctx.hardwareClient) {
      ctx.hardwareClient.disconnect()
    }

    if (ctx.server) {
      await ctx.server.stop()
    }
  })

  return ctx
}

/**
 * Wait for a condition to be true within a timeout.
 * Useful for testing asynchronous state changes.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 1000,
  intervalMs = 10
): Promise<void> {
  const startTime = Date.now()

  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return
    }
    await sleep(intervalMs)
  }

  throw new Error(`Condition not met within ${timeoutMs}ms`)
}

/**
 * Promise-based sleep utility.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Create a promise that never resolves (for testing timeouts).
 */
export function neverResolves<T>(): Promise<T> {
  return new Promise(() => {})
}

/**
 * Create a readable stream from a string.
 * Useful for testing MessageStream with controlled data.
 */
export function createMockReadable(data: string[]): NodeJS.ReadableStream {
  const stream: any = {
    pipe: (destination: any) => {
      // Simulate async data emission
      setTimeout(() => {
        for (const chunk of data) {
          destination.emit?.('data', Buffer.from(chunk))
        }
        destination.emit?.('end')
      }, 0)
      return destination
    },
    unpipe: () => {},
    on: () => stream,
    once: () => stream,
    removeListener: () => stream,
  }
  return stream
}
