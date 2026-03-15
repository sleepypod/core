/**
 * FrankenServer — literal port of free-sleep's FrankenServer stack.
 *
 * Combines UnixSocketServer + FrankenServer + MessageStream + SequentialQueue
 * into a single self-contained module.
 *
 * Exports:
 *   connectFranken(socketPath)  — connect (with retry/timeout loop)
 *   sendCommand(command, arg)   — send a numbered command to frankenfirmware
 *   disconnectFranken()         — tear down everything
 *
 * The message protocol, socket creation, connection handling, and retry loop
 * are copied as-is from free-sleep. DO NOT refactor.
 */

import { once } from 'events'
import { unlink } from 'fs/promises'
import { createServer, type Server, type Socket } from 'net'
import split from 'binary-split'
import type { Transform } from 'stream'

// ─── toPromise / wait (from free-sleep's promises.ts) ────────────────────────

function toPromise(func: (cb: (err: unknown, result?: unknown) => void) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    func((err, result) => {
      if (err) reject(err)
      else resolve(result)
    })
  })
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, milliseconds)
  })
}

// ─── SequentialQueue (from free-sleep) ───────────────────────────────────────

class SequentialQueue {
  private executing = Promise.resolve()

  private execInternal(f: () => Promise<void>) {
    const current = this.executing
    // eslint-disable-next-line no-async-promise-executor
    const newPromise = new Promise<void>(async (resolve) => {
      await current
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
        } catch (err) {
          reject(err)
        }
      })
    })
  }
}

// ─── MessageStream (from free-sleep) ─────────────────────────────────────────

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
    readable.on('error', (error) => this.splitter.destroy(error as Error))
  }

  public async readMessage(): Promise<Buffer> {
    // eslint-disable-next-line no-constant-condition
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

// ─── UnixSocketServer (from free-sleep) ──────────────────────────────────────

class UnixSocketServer {
  private readonly pendingConnections: Socket[] = []
  private waiting: ((socket: Socket) => void) | undefined

  public constructor(private readonly server: Server) {
    this.server.on('connection', (socket) => this.handleConnection(socket))
  }

  private handleConnection(socket: Socket) {
    socket.on('error', (error) => console.error('[Franken] Unix socket connection error:', error))

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
      const connection = this.pendingConnections.shift() as Socket
      return connection
    }

    console.log('[Franken] Waiting for future connection')
    return new Promise<Socket>((resolve) => this.waiting = resolve)
  }

  public static async start(path: string) {
    console.log('[Franken] Creating socket connection...')
    await UnixSocketServer.tryCleanup(path)
    const unixSocketServer = createServer()
    unixSocketServer.on('error', (error) => console.error('[Franken] Unix socket server error:', error))

    await new Promise<void>((resolve) => unixSocketServer.listen(path, resolve))

    // Match free-sleep's socket ownership (runs as dac user)
    try {
      const { chownSync, chmodSync } = require('fs')
      chownSync(path, 1000, 1000) // dac:dac (uid/gid 1000)
      chmodSync(path, 0o777)
    } catch { /* best effort */ }

    const socket = new UnixSocketServer(unixSocketServer)
    console.log('[Franken] Created socket connection!')
    return socket
  }

  private static async tryCleanup(path: string) {
    try {
      await unlink(path)
    } catch (err) {
      if ((err as any)?.code === 'ENOENT') return
      throw err
    }
  }
}

// ─── Franken (from free-sleep) ───────────────────────────────────────────────

class Franken {
  private static readonly responseDelayMs = 10

  public constructor(
    private readonly socket: Socket,
    private readonly messageStream: MessageStream,
    private readonly sequentialQueue: SequentialQueue,
  ) {
  }

  static readonly separator = Buffer.from('\n\n')

  public async sendMessage(message: string) {
    console.log(`[Franken] Sending message to sock | message: ${message}`)
    const responseBytes = await this.sequentialQueue.exec(async () => {
      const requestBytes = Buffer.concat([Buffer.from(message), Franken.separator])
      await this.write(requestBytes)
      const resp = await this.messageStream.readMessage()

      if (Franken.responseDelayMs > 0) {
        await wait(10)
      }
      return resp
    })
    const response = responseBytes.toString()
    console.log(`[Franken] Message sent successfully to sock | message: ${message}`)

    return response
  }

  private tryStripNewlines(arg: string) {
    const containsNewline = arg.indexOf('\n') >= 0
    if (!containsNewline) return arg
    return arg.replace(/\n/gm, '')
  }

  public async callFunction(commandNumber: string, arg: string): Promise<string> {
    console.log(`[Franken] Calling function | commandNumber: ${commandNumber} | arg: ${arg}`)
    const cleanedArg = this.tryStripNewlines(arg)
    console.log(`[Franken] cleanedArg: ${cleanedArg}`)
    return this.sendMessage(`${commandNumber}\n${cleanedArg}`)
  }

  public async getDeviceStatusRaw(): Promise<string> {
    const response = await this.sendMessage('14')
    return response
  }

  public close() {
    const socket = this.socket
    if (!socket.destroyed) socket.destroy()
  }

  public static fromSocket(socket: Socket) {
    const messageStream = new MessageStream(socket, Franken.separator)
    return new Franken(socket, messageStream, new SequentialQueue())
  }

  private async write(data: Buffer) {
    await toPromise(cb => this.socket.write(data, cb as (err?: Error | null) => void))
  }
}

// ─── FrankenServer (from free-sleep) ─────────────────────────────────────────

class FrankenServer {
  public constructor(private readonly server: UnixSocketServer) {
  }

  public async close() {
    console.log('[Franken] Closing FrankenServer socket...')
    await this.server.close()
  }

  public async waitForFranken(): Promise<Franken> {
    const socket = await this.server.waitForConnection()
    console.log('[Franken] FrankenServer connected')
    return Franken.fromSocket(socket)
  }

  public static async start(path: string) {
    console.log(`[Franken] Creating franken server on socket: ${path}`)
    const unixSocketServer = await UnixSocketServer.start(path)
    return new FrankenServer(unixSocketServer)
  }
}

// ─── Timeout helper (from free-sleep) ────────────────────────────────────────

const FRANKEN_CONNECTION_TIMEOUT_MS = 25_000

class FrankenConnectionTimeoutError extends Error {
  public constructor() {
    super('Timed out waiting for Franken hardware connection')
    this.name = 'FrankenConnectionTimeoutError'
  }
}

function promiseWithTimeout<T>(promise: Promise<T>, onTimeout: () => Error) {
  let timeout: NodeJS.Timeout | undefined
  return new Promise<T>((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(onTimeout())
    }, FRANKEN_CONNECTION_TIMEOUT_MS)

    promise
      .then(value => {
        if (timeout) clearTimeout(timeout)
        resolve(value)
      })
      .catch(error => {
        if (timeout) clearTimeout(timeout)
        reject(error)
      })
  })
}

// ─── Module-level state (from free-sleep) ────────────────────────────────────

let frankenServer: FrankenServer | undefined
let franken: Franken | undefined
let connectPromise: Promise<Franken> | undefined

function waitForFrankenWithTimeout(server: FrankenServer) {
  if (!FRANKEN_CONNECTION_TIMEOUT_MS) {
    return server.waitForFranken()
  }

  const timeoutMessage = `Restarting Franken after ${FRANKEN_CONNECTION_TIMEOUT_MS / 1_000}s timeout`
  return promiseWithTimeout(server.waitForFranken(), () => {
    console.warn(`[Franken] ${timeoutMessage}`)
    return new FrankenConnectionTimeoutError()
  })
}

async function shutdownFrankenServer() {
  franken?.close()
  franken = undefined
  if (frankenServer) {
    await frankenServer.close()
    frankenServer = undefined
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Connect to frankenfirmware via the Unix socket.
 * Starts a server, waits for the firmware to connect.
 * Retries with server recreation on timeout (matching free-sleep exactly).
 */
export async function connectFranken(socketPath: string): Promise<void> {
  if (franken) return
  if (connectPromise) {
    await connectPromise
    return
  }

  connectPromise = (async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (!frankenServer) {
        frankenServer = await FrankenServer.start(socketPath)
        console.log('[Franken] FrankenServer started')
      }

      try {
        console.log('[Franken] Waiting for Franken hardware connection...')
        franken = await waitForFrankenWithTimeout(frankenServer)
        console.log('[Franken] Franken socket connected')
        return franken
      } catch (error) {
        if (error instanceof FrankenConnectionTimeoutError) {
          console.warn('[Franken] Unable to connect to Franken within timeout, restarting socket server...')
          await shutdownFrankenServer()
          continue
        }
        await shutdownFrankenServer()
        throw error
      }
    }
  })()

  try {
    await connectPromise
  } finally {
    connectPromise = undefined
  }
}

/**
 * Send a command to frankenfirmware.
 *
 * Without arg: sends just the command number (e.g. DEVICE_STATUS = '14')
 * With arg:    sends "{commandNumber}\n{cleanedArg}" (e.g. SET_TEMP)
 *
 * Always returns the raw response string from the firmware.
 *
 * @param command - The command number as a string (e.g. '14' for DEVICE_STATUS)
 * @param arg     - Optional argument string
 * @returns The raw response string from the firmware
 */
export async function sendCommand(command: string, arg?: string): Promise<string> {
  if (!franken) {
    throw new Error('[Franken] Not connected — call connectFranken() first')
  }

  if (arg === undefined || arg === '') {
    // Commands without args (like DEVICE_STATUS) just send the command number
    return franken.sendMessage(command)
  }

  // Commands with args: "{commandNumber}\n{arg}"
  return franken.callFunction(command, arg)
}

/**
 * Disconnect and tear down the FrankenServer.
 */
export async function disconnectFranken(): Promise<void> {
  connectPromise = undefined
  await shutdownFrankenServer()
}

/**
 * Check if franken is currently connected.
 */
export function isFrankenConnected(): boolean {
  return franken !== undefined
}
