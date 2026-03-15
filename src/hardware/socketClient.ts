import { Socket } from 'net'
import { MessageStream } from './messageStream'
import { SequentialQueue } from './sequentialQueue'
import type {
  HardwareCommand } from './types'
import {
  CommandExecutionError,
  ConnectionTimeoutError,
  HardwareError,
} from './types'

/**
 * Low-level Unix socket client for Pod hardware communication.
 *
 * Responsibilities:
 * - Raw socket I/O (connect, read, write, close)
 * - Message framing (newline-delimited protocol)
 * - Sequential command execution via queue
 * - Basic error handling
 *
 * Does NOT handle:
 * - Connection management (see HardwareClient)
 * - Auto-reconnection
 * - Response parsing (see responseParser)
 * - Temperature conversion
 *
 * Protocol Details:
 * - Commands: "{code}\n{argument}\n\n" (double newline delimiter)
 * - Responses: Text or key=value pairs, terminated by "\n\n"
 * - Transport: Unix domain socket (typically /run/dac.sock)
 * - Encoding: UTF-8 text
 *
 * Thread Safety: Uses SequentialQueue to prevent concurrent writes
 * which could corrupt the protocol stream.
 *
 * @example
 * ```typescript
 * const client = await connectToSocket('/run/dac.sock')
 * const response = await client.executeCommand(HardwareCommand.DEVICE_STATUS)
 * client.close()
 * ```
 */
export class SocketClient {
  private readonly queue = new SequentialQueue()
  private readonly messageStream: MessageStream
  private closed = false

  constructor(private readonly socket: Socket) {
    this.messageStream = new MessageStream(socket)

    socket.on('error', (error) => {
      console.error('Socket error:', error)
    })

    socket.on('close', () => {
      this.closed = true
      this.messageStream.destroy()
    })
  }

  /**
   * Executes a hardware command and waits for the response.
   *
   * Commands are queued and executed sequentially to prevent:
   * - Protocol corruption (interleaved messages)
   * - Hardware race conditions (conflicting commands)
   * - Response mismatching (getting wrong command's response)
   *
   * Flow:
   * 1. Waits for previous command to complete
   * 2. Sanitizes argument (removes newlines that would break protocol)
   * 3. Sends formatted message: "{code}\n{argument}\n\n"
   * 4. Waits 10ms (hardware processing delay)
   * 5. Reads response from message stream
   *
   * The 10ms delay is required because the hardware controller buffers writes
   * and may not have the response ready immediately. Without this delay, we
   * occasionally read stale responses from previous commands.
   *
   * @param command - Hardware command enum value
   * @param argument - Optional command argument (default: empty string)
   * @returns Raw response string from hardware
   * @throws {Error} If socket is closed
   * @throws {CommandExecutionError} If command execution fails
   *
   * @example
   * ```typescript
   * // Command without argument
   * const response = await client.executeCommand(HardwareCommand.DEVICE_STATUS)
   *
   * // Command with argument
   * await client.executeCommand(HardwareCommand.TEMP_LEVEL_LEFT, '50')
   * ```
   */
  async executeCommand(
    command: HardwareCommand,
    argument: string = ''
  ): Promise<string> {
    if (this.closed) {
      throw new Error('Socket is closed')
    }

    return this.queue.exec(async () => {
      try {
        // Remove newlines to prevent protocol injection attacks.
        // Hardware uses \n as delimiter, so embedded newlines would
        // corrupt the message framing.
        const cleanArg = argument.replace(/\n/g, '')

        // Format according to hardware protocol: "{code}\n{argument}\n\n"
        const message = `${command}\n${cleanArg}\n\n`

        // Write to socket
        await this.writeToSocket(message)

        // CRITICAL: Wait for hardware to process command and buffer response.
        // Without this delay, we might read a stale response from the previous
        // command, causing response mismatch bugs.
        await this.delay(10)

        // Read response (blocks until "\n\n" delimiter received)
        const responseBuffer = await this.messageStream.readMessage()
        return responseBuffer.toString('utf-8')
      }
      catch (error) {
        throw new CommandExecutionError(
          `Failed to execute command ${command}: ${error}`,
          command
        )
      }
    })
  }

  /**
   * Writes data to the socket with promise-based completion.
   *
   * Wraps Node.js's callback-style socket.write() in a promise for
   * easier async/await usage and error handling.
   *
   * @param data - String data to write to socket
   * @returns Promise that resolves when write completes
   * @throws Rejects if write fails (e.g., socket closed, buffer full)
   */
  private writeToSocket(data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(data, (error) => {
        if (error) {
          reject(error)
        }
        else {
          resolve()
        }
      })
    })
  }

  /**
   * Promise-based delay utility.
   *
   * Used for hardware timing requirements - not arbitrary delays.
   * The 10ms delay after writes allows the hardware controller's
   * receive buffer to be populated before we attempt to read.
   *
   * @param ms - Milliseconds to delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Checks if the socket connection has been closed.
   *
   * Returns true if:
   * - close() was called explicitly
   * - Remote end closed the connection
   * - Socket error occurred
   *
   * @returns true if closed, false if still open
   */
  isClosed(): boolean {
    return this.closed
  }

  /**
   * Immediately closes the socket connection.
   *
   * Uses socket.destroy() rather than socket.end() to force immediate
   * closure without waiting for graceful shutdown. This is appropriate
   * because the hardware protocol has no close handshake.
   *
   * Idempotent - safe to call multiple times.
   *
   * Note: Does NOT clean up the MessageStream - that's handled by the
   * socket 'close' event listener.
   */
  close() {
    if (!this.closed) {
      this.socket.destroy()
      this.closed = true
    }
  }

  /**
   * Provides access to the underlying Node.js Socket.
   *
   * Use Cases:
   * - Listening to socket events (error, timeout, close)
   * - Checking connection state
   * - Setting socket options (keepalive, timeout)
   *
   * WARNING: Do not write directly to this socket - use executeCommand()
   * to maintain protocol integrity and command queuing.
   *
   * @returns The underlying Node.js Socket instance
   */
  getSocket(): Socket {
    return this.socket
  }
}

/**
 * Wraps an already-connected socket in a SocketClient.
 *
 * Used when the socket comes from a DacSocketServer (server mode) rather
 * than from a client connection. The socket must already be connected.
 *
 * @param socket - A connected Node.js Socket (e.g., from DacSocketServer.waitForConnection())
 * @returns SocketClient ready for command execution
 */
export function wrapSocket(socket: Socket): SocketClient {
  return new SocketClient(socket)
}

/**
 * Establishes a Unix socket connection to the Pod hardware daemon.
 *
 * This is the CLIENT mode — used for development/testing when connecting
 * TO an existing socket. In production, use DacSocketServer + wrapSocket()
 * instead (the hardware connects to US).
 *
 * @param socketPath - Path to Unix socket (e.g., /run/dac.sock)
 * @param timeoutMs - Connection timeout in milliseconds (default: 25000)
 * @returns Connected SocketClient ready for command execution
 * @throws {ConnectionTimeoutError} If connection times out
 * @throws {HardwareError} For other connection failures
 */
export async function connectToSocket(
  socketPath: string,
  timeoutMs = 25000
): Promise<SocketClient> {
  return new Promise((resolve, reject) => {
    const socket = new Socket()
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new ConnectionTimeoutError(`Connection timeout after ${timeoutMs}ms`))
    }, timeoutMs)

    socket.connect(socketPath, () => {
      clearTimeout(timeout)
      const client = new SocketClient(socket)
      resolve(client)
    })

    socket.on('error', (error) => {
      clearTimeout(timeout)
      const hwError = new HardwareError(
        `Socket connection failed: ${error.message}`,
        'SOCKET_ERROR'
      )
      reject(hwError)
    })
  })
}
