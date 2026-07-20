import { EventEmitter } from 'node:events'
import * as fsModule from 'node:fs'
import * as fsPromisesModule from 'node:fs/promises'
import * as netModule from 'node:net'
import type { Transform } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

interface TransportModule {
  backoffDelayMs: (attempt: number) => number
  connectDac: (socketPath: string) => Promise<void>
  disconnectDac: () => Promise<void>
  isDacConnected: () => boolean
  sendCommand: (command: string, arg?: string) => Promise<string>
}

class HarnessSocket extends EventEmitter {
  destination: Transform | null = null
  destroyed = false
  destroyCalls = 0
  readonly writes: Buffer[] = []
  pipeError: Error | null = null
  nextWriteError: Error | null = null
  beforeNextWriteCallback: (() => void | Promise<void>) | null = null

  pipe(destination: Transform): Transform {
    if (this.pipeError) throw this.pipeError
    this.destination = destination
    return destination
  }

  write(data: Uint8Array, callback: (error?: Error | null) => void): boolean {
    this.writes.push(Buffer.from(data))
    const error = this.nextWriteError
    const beforeCallback = this.beforeNextWriteCallback
    this.nextWriteError = null
    this.beforeNextWriteCallback = null

    queueMicrotask(() => {
      Promise.resolve(beforeCallback?.()).then(() => callback(error))
    })
    return true
  }

  respond(message: string): void {
    if (!this.destination) throw new Error('Socket has not been piped')
    this.destination.write(Buffer.from(message))
  }

  async failStream(error: Error): Promise<void> {
    if (!this.destination) throw new Error('Socket has not been piped')
    const observed = new Promise<void>(resolve => this.destination?.once('error', () => resolve()))
    this.emit('error', error)
    await observed
  }

  async endStream(): Promise<void> {
    if (!this.destination) throw new Error('Socket has not been piped')
    const observed = new Promise<void>(resolve => this.destination?.once('end', () => resolve()))
    this.destination.end()
    await observed
  }

  destroy(): this {
    this.destroyCalls += 1
    this.destroyed = true
    queueMicrotask(() => this.emit('close'))
    return this
  }
}

const harness = {
  listenError: null as Error | null,
  prequeuedSocket: null as HarnessSocket | null,
  servers: [] as HarnessServer[],
}

class HarnessServer extends EventEmitter {
  closeCalls = 0
  listeningPath: string | null = null

  override on(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
    super.on(eventName, listener)
    if (eventName === 'connection' && harness.prequeuedSocket) {
      const socket = harness.prequeuedSocket
      harness.prequeuedSocket = null
      this.emit('connection', socket)
    }
    return this
  }

  listen(path: string, callback: () => void): this {
    this.listeningPath = path
    queueMicrotask(() => {
      if (harness.listenError) this.emit('error', harness.listenError)
      else callback()
    })
    return this
  }

  close(): this {
    this.closeCalls += 1
    queueMicrotask(() => this.emit('close'))
    return this
  }
}

const createServerMock = vi.fn(() => {
  const server = new HarnessServer()
  harness.servers.push(server)
  return server
})
const chownSyncMock = vi.fn<(path: string, uid: number, gid: number) => void>()
const chmodSyncMock = vi.fn<(path: string, mode: number) => void>()
const unlinkMock = vi.fn<(path: string) => Promise<void>>()

let transport: TransportModule

function enoent(): Error & { code: string } {
  return Object.assign(new Error('socket path does not exist'), { code: 'ENOENT' })
}

async function waitForCondition(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  throw new Error(message)
}

async function connectHarnessSocket(
  path = '/tmp/dac-transport-contract.sock',
  socket = new HarnessSocket(),
): Promise<{ server: HarnessServer, socket: HarnessSocket }> {
  const connection = transport.connectDac(path)
  await waitForCondition(
    () => (harness.servers.at(-1)?.listenerCount('connection') ?? 0) > 0,
    'DAC server did not install its connection listener',
  )
  const server = harness.servers.at(-1)
  if (!server) throw new Error('DAC server was not created')
  server.emit('connection', socket)
  await connection
  return { server, socket }
}

async function waitForWrites(socket: HarnessSocket, count: number): Promise<void> {
  await waitForCondition(
    () => socket.writes.length >= count,
    `Expected ${count} socket write(s), saw ${socket.writes.length}`,
  )
}

describe('dacTransport private transport contracts through the public API', () => {
  beforeAll(async () => {
    vi.doMock('net', () => ({
      ...netModule,
      createServer: createServerMock,
      default: { ...netModule, createServer: createServerMock },
    }))
    vi.doMock('fs', () => ({
      ...fsModule,
      chownSync: chownSyncMock,
      chmodSync: chmodSyncMock,
      default: { ...fsModule, chownSync: chownSyncMock, chmodSync: chmodSyncMock },
    }))
    vi.doMock('fs/promises', () => ({
      ...fsPromisesModule,
      unlink: unlinkMock,
      default: { ...fsPromisesModule, unlink: unlinkMock },
    }))
    transport = await import('../dacTransport')
  })

  beforeEach(() => {
    harness.listenError = null
    harness.prequeuedSocket = null
    harness.servers.length = 0
    createServerMock.mockClear()
    chownSyncMock.mockReset()
    chmodSyncMock.mockReset()
    unlinkMock.mockReset().mockRejectedValue(enoent())
    delete process.env.DAC_MESSAGE_RESPONSE_TIMEOUT_MS
    delete process.env.DAC_CONNECTION_TIMEOUT_MS
    delete process.env.DAC_RECONNECT_DELAY_MS
    delete process.env.DAC_RECONNECT_MAX_ATTEMPTS
  })

  afterEach(async () => {
    await transport.disconnectDac()
    vi.restoreAllMocks()
  })

  afterAll(() => {
    vi.doUnmock('net')
    vi.doUnmock('fs')
    vi.doUnmock('fs/promises')
  })

  it('removes a stale path and applies the DAC socket ownership and mode', async () => {
    unlinkMock.mockResolvedValueOnce()
    const path = '/tmp/stale-dac.sock'

    await connectHarnessSocket(path)

    expect(unlinkMock).toHaveBeenCalledWith(path)
    expect(chownSyncMock).toHaveBeenCalledWith(path, 1000, 1000)
    expect(chmodSyncMock).toHaveBeenCalledWith(path, 0o770)
  })

  it('propagates non-ENOENT cleanup failures without starting a server', async () => {
    const cleanupError = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    unlinkMock.mockRejectedValueOnce(cleanupError)
    harness.listenError = new Error('server should not start')

    await expect(transport.connectDac('/tmp/protected-dac.sock')).rejects.toBe(cleanupError)
    expect(createServerMock).not.toHaveBeenCalled()
  })

  it('rejects startup listen errors and clears the failed in-flight connection for retry', async () => {
    const listenError = new Error('listen failed')
    harness.listenError = listenError

    await expect(transport.connectDac('/tmp/startup-error.sock')).rejects.toBe(listenError)

    harness.listenError = null
    const socket = new HarnessSocket()
    const secondConnection = transport.connectDac('/tmp/startup-error.sock')
    await waitForCondition(() => harness.servers.length === 2, 'Retry did not create a new server')
    const secondServer = harness.servers[1]
    await waitForCondition(
      () => secondServer.listenerCount('connection') > 0,
      'Retry server did not install its connection listener',
    )
    secondServer.emit('connection', socket)

    await expect(secondConnection).resolves.toBeUndefined()
    expect(transport.isDacConnected()).toBe(true)
  })

  it('replaces the startup error handler with one exact runtime handler', async () => {
    const { server } = await connectHarnessSocket()

    expect(server.listenerCount('error')).toBe(1)
  })

  it('logs runtime server errors with their original object', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { server } = await connectHarnessSocket()
    const failure = new Error('runtime server failure')

    server.emit('error', failure)

    expect(errorLog).toHaveBeenCalledWith('[DAC] server error:', failure)
  })

  it('logs accepted-socket errors with their original object', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { socket } = await connectHarnessSocket()
    const failure = new Error('accepted socket failure')

    socket.emit('error', failure)

    expect(errorLog).toHaveBeenCalledWith('[DAC] socket connection error:', failure)
  })

  it('does not begin a queued write until the preceding response has settled', async () => {
    const { socket } = await connectHarnessSocket()

    const first = transport.sendCommand('first')
    const second = transport.sendCommand('second')
    await waitForWrites(socket, 1)
    expect(socket.writes.map(write => write.toString())).toEqual(['first\n\n'])

    socket.respond('FIRST\n\n')
    await expect(first).resolves.toBe('FIRST')
    await waitForWrites(socket, 2)
    expect(socket.writes.map(write => write.toString())).toEqual(['first\n\n', 'second\n\n'])

    socket.respond('SECOND\n\n')
    await expect(second).resolves.toBe('SECOND')
  })

  it('rejects when the socket write callback reports an error', async () => {
    const { socket } = await connectHarnessSocket()
    const failure = new Error('write callback failed')
    socket.nextWriteError = failure

    await expect(transport.sendCommand('write-failure')).rejects.toBe(failure)
  })

  it('preserves a stream error that arrives before response reading starts', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.env.DAC_MESSAGE_RESPONSE_TIMEOUT_MS = '25'
    const { socket } = await connectHarnessSocket()
    const failure = new Error('firmware stream failed')
    socket.beforeNextWriteCallback = () => socket.failStream(failure)

    await expect(transport.sendCommand('stream-error')).rejects.toBe(failure)
    expect(errorLog).toHaveBeenCalledWith('[DAC] socket connection error:', failure)
  })

  it('reports an ended stream instead of waiting for the response timeout', async () => {
    process.env.DAC_MESSAGE_RESPONSE_TIMEOUT_MS = '25'
    const { socket } = await connectHarnessSocket()
    socket.beforeNextWriteCallback = () => socket.endStream()

    await expect(transport.sendCommand('stream-end')).rejects.toThrow('stream ended')
  })

  it('keeps only the newest unsolicited connection and closes every pending socket on shutdown', async () => {
    const { server } = await connectHarnessSocket()
    const stale = new HarnessSocket()
    const newest = new HarnessSocket()

    server.emit('connection', stale)
    expect(stale.destroyed).toBe(false)
    server.emit('connection', newest)

    expect(stale.destroyCalls).toBe(1)
    expect(newest.destroyed).toBe(false)

    await transport.disconnectDac()

    expect(newest.destroyCalls).toBe(1)
    expect(server.closeCalls).toBe(1)
  })

  it('consumes a connection queued before waitForConnection starts', async () => {
    const socket = new HarnessSocket()
    harness.prequeuedSocket = socket

    await expect(transport.connectDac('/tmp/prequeued-dac.sock')).resolves.toBeUndefined()

    expect(transport.isDacConnected()).toBe(true)
    expect(socket.destroyed).toBe(false)
  })

  it('warns exactly for discarded stale responses and stays silent for an empty queue', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { socket } = await connectHarnessSocket()
    socket.respond('STALE\n\n')
    await new Promise<void>(resolve => setImmediate(resolve))

    const command = transport.sendCommand('fresh')
    await waitForWrites(socket, 1)
    expect(warning).toHaveBeenCalledWith(
      '[DAC] discarded 1 stale response(s) before sending next command',
    )
    socket.respond('FRESH\n\n')
    await command

    warning.mockClear()
    const cleanCommand = transport.sendCommand('clean')
    await waitForWrites(socket, 2)
    expect(warning).not.toHaveBeenCalled()
    socket.respond('CLEAN\n\n')
    await cleanCommand
  })

  it('strips newlines even when the first argument character is a newline', async () => {
    const { socket } = await connectHarnessSocket()

    const command = transport.sendCommand('sanitize', '\nleft\nright\n')
    await waitForWrites(socket, 1)
    expect(socket.writes[0]?.toString()).toBe('sanitize\nleftright\n\n')
    socket.respond('OK\n\n')

    await expect(command).resolves.toBe('OK')
  })

  it.each(['garbage', '0', '-5'])(
    'falls back to 30 seconds for invalid response timeout %j',
    async (rawTimeout) => {
      process.env.DAC_MESSAGE_RESPONSE_TIMEOUT_MS = rawTimeout
      const { socket } = await connectHarnessSocket()
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')

      const command = transport.sendCommand('timeout-fallback')
      await waitForWrites(socket, 1)
      expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 30_000)).toBe(true)
      socket.respond('OK\n\n')
      await command
    },
  )

  it.each(['garbage', '0', '-5'])(
    'falls back to 25 seconds for invalid connection timeout %j',
    async (rawTimeout) => {
      process.env.DAC_CONNECTION_TIMEOUT_MS = rawTimeout
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')

      await connectHarnessSocket()

      expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 25_000)).toBe(true)
    },
  )

  it('uses the documented response delay and clears its response timer', async () => {
    const { socket } = await connectHarnessSocket()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')

    const command = transport.sendCommand('timed-response')
    await waitForWrites(socket, 1)
    const responseTimerCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 30_000)
    const responseTimerIndex = responseTimerCall
      ? setTimeoutSpy.mock.calls.indexOf(responseTimerCall)
      : -1
    const responseTimer = responseTimerIndex >= 0
      ? setTimeoutSpy.mock.results[responseTimerIndex]?.value
      : undefined
    socket.respond('OK\n\n')

    await expect(command).resolves.toBe('OK')
    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 10)).toBe(true)
    expect(responseTimer).toBeDefined()
    expect(clearTimeoutSpy).toHaveBeenCalledWith(responseTimer)
  })

  it('clears the connection timer after firmware connects', async () => {
    process.env.DAC_CONNECTION_TIMEOUT_MS = '123'
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')

    await connectHarnessSocket()

    const timerCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 123)
    const timerIndex = timerCall ? setTimeoutSpy.mock.calls.indexOf(timerCall) : -1
    const timer = timerIndex >= 0 ? setTimeoutSpy.mock.results[timerIndex]?.value : undefined
    expect(timer).toBeDefined()
    expect(clearTimeoutSpy).toHaveBeenCalledWith(timer)
  })

  it('propagates non-timeout connection failures and clears their timer', async () => {
    process.env.DAC_CONNECTION_TIMEOUT_MS = '25'
    process.env.DAC_RECONNECT_MAX_ATTEMPTS = '1'
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const failure = new Error('socket pipe failed')
    const socket = new HarnessSocket()
    socket.pipeError = failure

    const connection = transport.connectDac('/tmp/pipe-error.sock')
    await waitForCondition(
      () => (harness.servers[0]?.listenerCount('connection') ?? 0) > 0,
      'DAC server did not install its connection listener',
    )
    const server = harness.servers[0]
    server.emit('connection', socket)

    await expect(connection).rejects.toBe(failure)
    const timerCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 25)
    const timerIndex = timerCall ? setTimeoutSpy.mock.calls.indexOf(timerCall) : -1
    const timer = timerIndex >= 0 ? setTimeoutSpy.mock.results[timerIndex]?.value : undefined
    expect(timer).toBeDefined()
    expect(clearTimeoutSpy).toHaveBeenCalledWith(timer)
    expect(server.closeCalls).toBe(1)
    expect(transport.isDacConnected()).toBe(false)
  })

  it.each([
    ['garbage', 1_000],
    ['-5', 1_000],
    ['0', 0],
  ] as const)(
    'uses reconnect delay fallback semantics for %j',
    async (rawDelay, expectedDelay) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      process.env.DAC_CONNECTION_TIMEOUT_MS = '5'
      process.env.DAC_RECONNECT_MAX_ATTEMPTS = '2'
      process.env.DAC_RECONNECT_DELAY_MS = rawDelay
      const nativeSetTimeout = globalThis.setTimeout
      let connectionTimerCount = 0
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((
        (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
          let acceleratedDelay = delay
          if (delay === 5) {
            connectionTimerCount += 1
            acceleratedDelay = connectionTimerCount === 1 ? 0 : 1_000
          }
          else if (delay === 1_000 || (delay !== undefined && delay <= 0)) {
            acceleratedDelay = 0
          }
          return nativeSetTimeout(callback, acceleratedDelay, ...args)
        }
      ) as typeof setTimeout)

      const connection = transport.connectDac('/tmp/reconnect-delay.sock')
      const observedConnection = connection.then(() => undefined, error => error)
      await new Promise<void>(resolve => nativeSetTimeout(resolve, 20))
      await waitForCondition(() => harness.servers.length >= 2, 'Reconnect did not create a second server')
      const retryServer = harness.servers[1]
      await waitForCondition(
        () => retryServer.listenerCount('connection') > 0,
        'Retry server did not install its connection listener',
      )
      retryServer.emit('connection', new HarnessSocket())
      await expect(observedConnection).resolves.toBeUndefined()

      expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === expectedDelay)).toBe(true)
    },
  )
})
