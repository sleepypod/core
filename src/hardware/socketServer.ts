import { createServer, type Server, type Socket } from 'net'
import { existsSync, unlinkSync } from 'fs'

/**
 * Unix socket server for DAC hardware connections.
 *
 * frankenfirmware connects TO this server at dac.sock.
 * Follows ninesleep's pattern: no handshake, no verification.
 * Each new connection replaces the previous one.
 *
 * Usage:
 *   const server = new DacSocketServer()
 *   await server.listen('/persistent/deviceinfo/dac.sock')
 *   const socket = await server.getConnection()  // blocks until connected
 */
export class DacSocketServer {
  private server: Server | null = null
  private socket: Socket | null = null
  private socketPath: string | null = null
  private waiters: Array<(socket: Socket) => void> = []

  /**
   * Start listening on a Unix socket path.
   * Cleans up stale socket files from previous runs.
   */
  async listen(path: string): Promise<void> {
    this.socketPath = path

    // Clean stale socket file
    if (existsSync(path)) {
      try { unlinkSync(path) } catch { /* ignore */ }
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((incoming: Socket) => {
        // ninesleep pattern: each new connection replaces the previous one
        if (this.socket && !this.socket.destroyed) {
          this.socket.destroy()
        }

        this.socket = incoming
        console.log('[DAC] frankenfirmware connected')

        incoming.on('error', (err) => {
          console.error('[DAC] socket error:', err.message)
        })

        incoming.on('close', () => {
          console.log('[DAC] frankenfirmware disconnected')
          if (this.socket === incoming) {
            this.socket = null
          }
        })

        // Wake up anyone waiting for a connection
        const waiter = this.waiters.shift()
        if (waiter) waiter(incoming)
      })

      this.server.on('error', (err) => reject(err))
      this.server.listen(path, () => {
        console.log(`[DAC] listening on ${path}`)
        // Match free-sleep's socket ownership (runs as dac user)
        // frankenfirmware may check socket owner
        try {
          const { chownSync, chmodSync } = require('fs')
          chownSync(path, 1000, 1000) // dac:dac (uid/gid 1000)
          chmodSync(path, 0o777)
        }
        catch { /* best effort */ }
        resolve()
      })
    })
  }

  /**
   * Get the current connection, or wait for one.
   * Returns immediately if frankenfirmware is already connected.
   */
  getConnection(timeoutMs = 30000): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) {
      return Promise.resolve(this.socket)
    }

    return new Promise((resolve, reject) => {
      let settled = false

      const waiter = (socket: Socket) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(socket)
      }

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const idx = this.waiters.indexOf(waiter)
        if (idx >= 0) this.waiters.splice(idx, 1)
        reject(new Error('Waiting for frankenfirmware connection timed out'))
      }, timeoutMs)

      this.waiters.push(waiter)
    })
  }

  /** Check if frankenfirmware is currently connected. */
  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed
  }

  /** Get the raw socket if connected, null otherwise. */
  getSocketIfConnected(): Socket | null {
    return this.socket && !this.socket.destroyed ? this.socket : null
  }

  /** Stop the server and clean up. */
  stop(): void {
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
    if (this.server) {
      this.server.close()
      this.server = null
    }
    // Reject all waiters
    this.waiters.forEach(() => { /* they'll timeout */ })
    this.waiters.length = 0
    if (this.socketPath && existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath) } catch { /* ignore */ }
    }
  }
}
