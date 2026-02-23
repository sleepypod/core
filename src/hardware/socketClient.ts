import { Socket } from 'net'
import { MessageStream } from './messageStream'
import { SequentialQueue } from './sequentialQueue'
import {
  CommandExecutionError,
  ConnectionTimeoutError,
  HardwareCommand,
} from './types'

/**
 * Unix socket client for hardware communication.
 * Manages low-level socket operations and message passing.
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
   * Execute a command and wait for response.
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
        // Clean argument to prevent injection
        const cleanArg = argument.replace(/\n/g, '')

        // Format message: "{commandCode}\n{argument}\n\n"
        const message = `${command}\n${cleanArg}\n\n`

        // Write to socket
        await this.writeToSocket(message)

        // Small delay for hardware processing
        await this.delay(10)

        // Read response
        const responseBuffer = await this.messageStream.readMessage()
        return responseBuffer.toString('utf-8')
      } catch (error) {
        throw new CommandExecutionError(
          `Failed to execute command ${command}: ${error}`,
          command
        )
      }
    })
  }

  /**
   * Write data to socket with promise wrapper.
   */
  private writeToSocket(data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(data, (error) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
  }

  /**
   * Utility delay function.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Check if socket is closed.
   */
  isClosed(): boolean {
    return this.closed
  }

  /**
   * Close the socket connection.
   */
  close() {
    if (!this.closed) {
      this.socket.destroy()
      this.closed = true
    }
  }

  /**
   * Get the underlying socket for advanced operations.
   */
  getSocket(): Socket {
    return this.socket
  }
}

/**
 * Create a socket connection to the hardware daemon.
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
      reject(error)
    })
  })
}
