/**
 * DAC Transport — Unix socket transport layer for Pod hardware communication.
 *
 * Ported from free-sleep's FrankenServer stack. The protocol, socket creation,
 * connection handling, and retry loop are preserved exactly as-is.
 *
 * Exports:
 *   connectDac(socketPath)   — start server, wait for frankenfirmware to connect
 *   sendCommand(command, arg) — send a numbered command to frankenfirmware
 *   disconnectDac()           — tear down everything
 *   isDacConnected()          — check connection status
 */

import { once } from 'events'
import { chownSync, chmodSync } from 'fs'
import { unlink } from 'fs/promises'
import { createServer, type Server, type Socket } from 'net'
import split from 'binary-split'
import type { Transform } from 'stream'

// ─── Utilities ───────────────────────────────────────────────────────────────

function toPromise(func: (cb: (err: unknown, result?: unknown) => void) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    func((err, result) => {
      if (err) reject(err)
      else resolve(result)
    })
  })
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

// ─── SequentialQueue ─────────────────────────────────────────────────────────

class SequentialQueue {
  private executing = Promise.resolve()

  private execInternal(f: () => Promise<void>) {
    const current = this.executing
    // eslint-disable-next-line no-async-promise-executor
    const newPromise = new Promise<void>(async (resolve) => {
      try {
        await current
      }
      catch { /* prevent poisoning */ }
      await f()
      resolve()
    })

    this.executing = newPromise
    return newPromise
  }

  public exec<T>(f: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.execInternal(async () => {
        try {
          resolve(await f())
        }
        catch (err) {
          reject(err)
        }
      })
    })
  }
}

// ─── MessageStream ───────────────────────────────────────────────────────────

class MessageStream {
  private readonly splitter: Transform
  private readonly queue: Buffer[] = []
  private ended = false
  private error: unknown

  public constructor(
    readable: NodeJS.ReadableStream,
    separator = Buffer.from('\n\n')
  ) {
    this.splitter = split(separator)
    this.splitter.on('data', (chunk: Buffer) => {
      this.queue.push(chunk)
    })
    this.splitter.on('end', () => {
      this.ended = true
    })
    this.splitter.on('error', (err: unknown) => {
      this.error = err
    })

    readable.pipe(this.splitter)
    readable.on('error', error => this.splitter.destroy(error as Error))
  }

  public async readMessage(): Promise<Buffer> {
    while (true) {
      if (this.queue.length > 0) {
        return this.queue.shift() as Buffer
      }

      if (this.error) {
        const err = this.error
        this.error = undefined
        throw err
      }

      if (this.ended) {
        throw new Error('stream ended')
      }

      await once(this.splitter, 'data')
    }
  }
}

// ─── SocketListener ──────────────────────────────────────────────────────────

class SocketListener {
  private readonly pendingConnections: Socket[] = []
  private waiting: ((socket: Socket) => void) | undefined

  public constructor(private readonly server: Server) {
    this.server.on('connection', socket => this.handleConnection(socket))
  }

  private handleConnection(socket: Socket) {
    socket.on('error', error => console.error('[DAC] socket connection error:', error))

    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = undefined
      resolve(socket)
      return
    }

    while (this.pendingConnections.length > 0) {
      const stale = this.pendingConnections.shift()
      stale?.destroy()
    }

    this.pendingConnections.push(socket)
  }

  public async close() {
    this.waiting = undefined
    this.pendingConnections.splice(0).forEach(socket => socket.destroy())
    this.server.close()
    await once(this.server, 'close')
  }

  public async waitForConnection(): Promise<Socket> {
    if (this.pendingConnections.length > 0) {
      return this.pendingConnections.shift() as Socket
    }

    console.log('[DAC] waiting for frankenfirmware...')
    return new Promise<Socket>(resolve => this.waiting = resolve)
  }

  public static async start(path: string) {
    await SocketListener.tryCleanup(path)
    const server = createServer()

    await new Promise<void>((resolve, reject) => {
      server.on('error', error => reject(error))
      server.listen(path, () => {
        // Replace the startup error handler with a runtime one
        server.removeAllListeners('error')
        server.on('error', error => console.error('[DAC] server error:', error))
        resolve()
      })
    })

    try {
      chownSync(path, 1000, 1000) // dac:dac
      chmodSync(path, 0o770)
    }
    catch { /* best effort */ }

    console.log(`[DAC] listening on ${path}`)
    return new SocketListener(server)
  }

  private static async tryCleanup(path: string) {
    try {
      await unlink(path)
    }
    catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return
      throw err
    }
  }
}

// ─── DacTransport (command execution over a connected socket) ────────────────

const SEPARATOR = Buffer.from('\n\n')
const RESPONSE_DELAY_MS = 10

class DacTransport {
  public constructor(
    private readonly socket: Socket,
    private readonly messageStream: MessageStream,
    private readonly sequentialQueue: SequentialQueue,
  ) {}

  public async sendMessage(message: string) {
    return this.sequentialQueue.exec(async () => {
      const requestBytes = Buffer.concat([Buffer.from(message), SEPARATOR])
      await this.write(requestBytes)
      const resp = await this.messageStream.readMessage()

      if (RESPONSE_DELAY_MS > 0) {
        await wait(RESPONSE_DELAY_MS)
      }
      return resp.toString()
    })
  }

  public async callFunction(commandNumber: string, arg: string): Promise<string> {
    const cleanedArg = arg.indexOf('\n') >= 0 ? arg.replace(/\n/gm, '') : arg
    return this.sendMessage(`${commandNumber}\n${cleanedArg}`)
  }

  public close() {
    if (!this.socket.destroyed) this.socket.destroy()
  }

  public static fromSocket(socket: Socket) {
    const messageStream = new MessageStream(socket, SEPARATOR)
    return new DacTransport(socket, messageStream, new SequentialQueue())
  }

  private async write(data: Buffer) {
    await toPromise(cb => this.socket.write(data, cb as (err?: Error | null) => void))
  }
}

// ─── DacServer (manages SocketListener + waits for connection) ───────────────

class DacServer {
  public constructor(private readonly listener: SocketListener) {}

  public async close() {
    await this.listener.close()
  }

  public async waitForConnection(): Promise<DacTransport> {
    const socket = await this.listener.waitForConnection()
    console.log('[DAC] frankenfirmware connected')
    return DacTransport.fromSocket(socket)
  }

  public static async start(path: string) {
    const listener = await SocketListener.start(path)
    return new DacServer(listener)
  }
}

// ─── Connection timeout ──────────────────────────────────────────────────────

const CONNECTION_TIMEOUT_MS = 25_000

class ConnectionTimeoutError extends Error {
  public constructor() {
    super('Timed out waiting for frankenfirmware connection')
    this.name = 'ConnectionTimeoutError'
  }
}

function withTimeout<T>(promise: Promise<T>, onTimeout: () => Error): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  return new Promise<T>((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(onTimeout())
    }, CONNECTION_TIMEOUT_MS)

    promise
      .then((value) => {
        if (timeout) clearTimeout(timeout)
        resolve(value)
      })
      .catch((error) => {
        if (timeout) clearTimeout(timeout)
        reject(error)
      })
  })
}

// ─── Module-level state ──────────────────────────────────────────────────────

let dacServer: DacServer | undefined
let transport: DacTransport | undefined
let connectPromise: Promise<DacTransport> | undefined

function waitWithTimeout(server: DacServer) {
  return withTimeout(server.waitForConnection(), () => {
    console.warn(`[DAC] restarting after ${CONNECTION_TIMEOUT_MS / 1_000}s timeout`)
    return new ConnectionTimeoutError()
  })
}

async function shutdown() {
  transport?.close()
  transport = undefined
  if (dacServer) {
    await dacServer.close()
    dacServer = undefined
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Start listening on dac.sock and wait for frankenfirmware to connect.
 * Retries with server recreation on timeout.
 */
export async function connectDac(socketPath: string): Promise<void> {
  if (transport) return
  if (connectPromise) {
    await connectPromise
    return
  }

  connectPromise = (async () => {
    while (true) {
      if (!dacServer) {
        dacServer = await DacServer.start(socketPath)
      }

      try {
        transport = await waitWithTimeout(dacServer)
        console.log('[DAC] connected')
        return transport
      }
      catch (error) {
        if (error instanceof ConnectionTimeoutError) {
          await shutdown()
          continue
        }
        await shutdown()
        throw error
      }
    }
  })()

  try {
    await connectPromise
  }
  finally {
    connectPromise = undefined
  }
}

/**
 * Send a command to frankenfirmware.
 *
 * @param command - Command number as string (e.g. '14' for DEVICE_STATUS)
 * @param arg     - Optional argument string
 * @returns Raw response string from firmware
 */
export async function sendCommand(command: string, arg?: string): Promise<string> {
  if (!transport) {
    throw new Error('[DAC] not connected — call connectDac() first')
  }

  if (arg === undefined || arg === '') {
    return transport.sendMessage(command)
  }

  return transport.callFunction(command, arg)
}

/**
 * Disconnect and tear down.
 */
export async function disconnectDac(): Promise<void> {
  connectPromise = undefined
  await shutdown()
}

/**
 * Check if frankenfirmware is currently connected.
 */
export function isDacConnected(): boolean {
  return transport !== undefined
}
