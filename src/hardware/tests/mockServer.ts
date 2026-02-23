/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { promises as fs } from 'fs'
import type { Server, Socket } from 'net'
import { createServer } from 'net'
import { HardwareCommand } from '../types'
import {
  DEVICE_STATUS_POD4,
  ERROR_RESPONSE,
  HELLO_RESPONSE,
  OK_RESPONSE,
  PROTOCOL,
} from './fixtures'

/**
 * Mock hardware daemon that simulates the Unix socket server.
 *
 * Provides configurable responses for testing various hardware scenarios
 * including normal operation, errors, timeouts, and edge cases.
 *
 * Usage:
 * ```typescript
 * const server = new MockHardwareServer('/tmp/test.sock')
 * await server.start()
 *
 * // Configure specific command responses
 * server.setCommandResponse(HardwareCommand.DEVICE_STATUS, 'custom response')
 *
 * // Test your client
 * const client = await connectToSocket('/tmp/test.sock')
 *
 * await server.stop()
 * ```
 */
export class MockHardwareServer {
  private server: Server | null = null
  private clients: Socket[] = []
  private commandResponses = new Map<string, string>()
  private commandDelays = new Map<string, number>()
  private shouldReject = false
  private connectionDelay = 0

  constructor(private readonly socketPath: string) {
    this.setupDefaultResponses()
  }

  /**
   * Set up default responses matching real hardware behavior.
   */
  private setupDefaultResponses() {
    this.commandResponses.set(HardwareCommand.HELLO, HELLO_RESPONSE)
    this.commandResponses.set(HardwareCommand.DEVICE_STATUS, DEVICE_STATUS_POD4)
    this.commandResponses.set(HardwareCommand.SET_TEMP, OK_RESPONSE)
    this.commandResponses.set(HardwareCommand.TEMP_LEVEL_LEFT, OK_RESPONSE)
    this.commandResponses.set(HardwareCommand.TEMP_LEVEL_RIGHT, OK_RESPONSE)
    this.commandResponses.set(HardwareCommand.LEFT_TEMP_DURATION, OK_RESPONSE)
    this.commandResponses.set(HardwareCommand.RIGHT_TEMP_DURATION, OK_RESPONSE)
    this.commandResponses.set(HardwareCommand.ALARM_LEFT, OK_RESPONSE)
    this.commandResponses.set(HardwareCommand.ALARM_RIGHT, OK_RESPONSE)
    this.commandResponses.set(HardwareCommand.ALARM_CLEAR, OK_RESPONSE)
    this.commandResponses.set(HardwareCommand.PRIME, OK_RESPONSE)
  }

  /**
   * Configure a custom response for a specific command.
   * Allows testing specific hardware states.
   */
  setCommandResponse(command: HardwareCommand, response: string) {
    this.commandResponses.set(command, response)
  }

  /**
   * Configure a delay for a specific command.
   * Simulates slow hardware processing.
   */
  setCommandDelay(command: HardwareCommand, delayMs: number) {
    this.commandDelays.set(command, delayMs)
  }

  /**
   * Configure the server to reject connections.
   * Simulates hardware daemon not running.
   */
  setShouldReject(reject: boolean) {
    this.shouldReject = reject
  }

  /**
   * Configure a delay before accepting connections.
   * Simulates slow daemon startup.
   */
  setConnectionDelay(delayMs: number) {
    this.connectionDelay = delayMs
  }

  /**
   * Reset all custom configurations to defaults.
   */
  reset() {
    this.commandResponses.clear()
    this.commandDelays.clear()
    this.shouldReject = false
    this.connectionDelay = 0
    this.setupDefaultResponses()
  }

  /**
   * Start the mock server listening on the socket path.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        if (this.shouldReject) {
          socket.destroy()
          return
        }

        this.clients.push(socket)
        this.handleClient(socket)
      })

      this.server.on('error', reject)

      this.server.listen(this.socketPath, () => {
        setTimeout(resolve, this.connectionDelay)
      })
    })
  }

  /**
   * Handle incoming client connections.
   * Parses commands and sends configured responses.
   */
  private handleClient(socket: Socket) {
    let buffer = ''

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8')

      // Process all complete commands in buffer
      // Protocol: "{command}\n{argument}\n\n"
      // For commands without arguments: "{command}\n\n\n" (extra newline for empty arg)
      while (buffer.includes(PROTOCOL.DELIMITER)) {
        const delimiterIndex = buffer.indexOf(PROTOCOL.DELIMITER)
        const message = buffer.substring(0, delimiterIndex)
        buffer = buffer.substring(delimiterIndex + PROTOCOL.DELIMITER.length)

        // Skip empty messages and trim any leading/trailing whitespace
        // This handles cases where the buffer has leftover newlines from previous messages
        const trimmedMessage = message.trim()
        if (trimmedMessage) {
          this.handleCommand(socket, trimmedMessage)
        }
      }
    })

    socket.on('error', (error) => {
      console.error('Mock server socket error:', error)
    })

    socket.on('close', () => {
      const index = this.clients.indexOf(socket)
      if (index !== -1) {
        this.clients.splice(index, 1)
      }
    })
  }

  /**
   * Process a hardware command and send the configured response.
   */
  private handleCommand(socket: Socket, message: string) {
    const lines = message.split('\n')
    const command = lines[0].trim() // Trim whitespace as defensive measure
    // const argument = lines[1] || '' // Not currently used, but protocol includes arguments

    const response = this.commandResponses.get(command) || ERROR_RESPONSE
    const delay = this.commandDelays.get(command) || 0

    setTimeout(() => {
      if (!socket.destroyed) {
        socket.write(response)
      }
    }, delay)
  }

  /**
   * Stop the server and close all connections.
   */
  async stop(): Promise<void> {
    // Close all client connections
    for (const client of this.clients) {
      client.destroy()
    }
    this.clients = []

    // Close server
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((error) => {
          if (error) {
            reject(error)
          }
          else {
            resolve()
          }
        })
      })

      // Clean up socket file
      try {
        await fs.unlink(this.socketPath)
      }
      catch {
        // Ignore errors - file might not exist
      }
    }
  }

  /**
   * Get the number of active client connections.
   */
  getClientCount(): number {
    return this.clients.length
  }

  /**
   * Send data to a specific client (for testing push notifications).
   */
  sendToClient(clientIndex: number, data: string) {
    if (clientIndex >= 0 && clientIndex < this.clients.length) {
      this.clients[clientIndex].write(data)
    }
  }
}

/**
 * Create a temporary socket path for testing.
 * Uses Node.js temp directory to avoid conflicts.
 */
export function createTestSocketPath(): string {
  return `/tmp/test-hardware-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`
}
