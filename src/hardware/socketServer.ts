import { createServer, type Server, type Socket } from 'net'
import { existsSync, unlinkSync } from 'fs'

/**
 * Unix socket server for DAC hardware connections.
 *
 * Eight.Capybara's frankenfirmware connects TO this server.
 * This follows the same pattern as free-sleep's FrankenServer:
 *
 * 1. Create server, listen on dac.sock
 * 2. Wait for frankenfirmware to connect
 * 3. If connection drops or times out, destroy server, recreate, wait again
 * 4. Once a stable connection is established, use it for commands
 *
 * frankenfirmware may connect/disconnect rapidly several times before
 * establishing a stable connection — this is normal behavior.
 */
export class DacSocketServer {
  private server: Server | null = null
  private activeSocket: Socket | null = null
  private socketPath: string | null = null

  /**
   * Wait for a stable hardware connection with retry loop.
   *
   * Creates a socket server, waits for frankenfirmware to connect.
   * If the connection drops or times out, destroys the server and tries again.
   * This matches free-sleep's connectFranken() pattern.
   *
   * @param path - Unix socket path to listen on
   * @param timeoutMs - Timeout per attempt (default: 25s)
   * @param maxRetries - Max retry attempts (default: unlimited via -1)
   * @returns Connected socket ready for command execution
   */
  async waitForStableConnection(
    path: string,
    timeoutMs = 25000,
    maxRetries = -1
  ): Promise<Socket> {
    this.socketPath = path
    let attempts = 0

    while (maxRetries === -1 || attempts < maxRetries) {
      attempts++

      try {
        // Clean up any existing server
        this.destroyServer()

        // Remove stale socket file
        this.cleanSocketFile(path)

        // Create fresh server
        await this.startServer(path)

        // Wait for connection
        const socket = await this.waitForConnection(timeoutMs)

        // Verify the connection is stable (wait a moment)
        const isStable = await this.verifyStable(socket, 500)
        if (!isStable) {
          console.log('[DacSocketServer] Connection dropped immediately, retrying...')
          continue
        }

        this.activeSocket = socket
        return socket
      }
      catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.log(`[DacSocketServer] Attempt ${attempts} failed: ${msg}`)

        if (maxRetries !== -1 && attempts >= maxRetries) {
          throw error
        }

        // Brief pause before retry
        await new Promise(r => setTimeout(r, 1000))
      }
    }

    throw new Error('Max retries exceeded waiting for hardware connection')
  }

  private startServer(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer()

      this.server.on('error', (error) => {
        console.error('[DacSocketServer] Server error:', error.message)
        reject(error)
      })

      this.server.listen(path, () => {
        console.log(`[DacSocketServer] Listening on ${path}`)
        resolve()
      })
    })
  }

  private waitForConnection(timeoutMs: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        reject(new Error('Server not started'))
        return
      }

      const timer = setTimeout(() => {
        reject(new Error(`No hardware connection within ${timeoutMs}ms`))
      }, timeoutMs)

      this.server.once('connection', (socket: Socket) => {
        clearTimeout(timer)
        console.log('[DacSocketServer] Hardware connected')

        socket.on('error', (error) => {
          console.error('[DacSocketServer] Connection error:', error.message)
        })

        socket.on('close', () => {
          console.log('[DacSocketServer] Hardware disconnected')
          if (this.activeSocket === socket) {
            this.activeSocket = null
          }
        })

        resolve(socket)
      })
    })
  }

  /**
   * Verify the connection stays alive for a brief period.
   * frankenfirmware sometimes connects and immediately disconnects.
   */
  private verifyStable(socket: Socket, waitMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (socket.destroyed) {
        resolve(false)
        return
      }

      const onClose = () => resolve(false)
      socket.once('close', onClose)

      setTimeout(() => {
        socket.removeListener('close', onClose)
        resolve(!socket.destroyed)
      }, waitMs)
    })
  }

  private destroyServer(): void {
    if (this.activeSocket) {
      this.activeSocket.destroy()
      this.activeSocket = null
    }

    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  private cleanSocketFile(path: string): void {
    if (existsSync(path)) {
      try {
        unlinkSync(path)
      }
      catch {
        // Ignore
      }
    }
  }

  /**
   * Check if a hardware client is currently connected.
   */
  isConnected(): boolean {
    return this.activeSocket !== null && !this.activeSocket.destroyed
  }

  /**
   * Stop the server and clean up everything.
   */
  stop(): void {
    this.destroyServer()

    if (this.socketPath) {
      this.cleanSocketFile(this.socketPath)
    }
  }
}
