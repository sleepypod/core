/**
 * Shared helper functions for tRPC routers
 */
import { TRPCError } from '@trpc/server'
import type { HardwareClient } from '@/src/hardware/client'
import { getSharedHardwareClient } from '@/src/hardware/dacMonitor.instance'

/**
 * Execute a callback with the shared hardware client.
 *
 * Uses the app-wide singleton HardwareClient (server mode) that listens
 * for frankenfirmware connections. The client persists across requests —
 * it is NOT disconnected after each call.
 *
 * If the first attempt fails with a socket error (ended/reset), reconnects
 * and retries once before throwing.
 */
export async function withHardwareClient<T>(
  callback: (client: HardwareClient) => Promise<T>,
  errorMessage: string
): Promise<T> {
  const client = getSharedHardwareClient()

  // Ensure connected (will wait for frankenfirmware if not yet connected)
  await client.connect()

  try {
    return await callback(client)
  }
  catch (error) {
    if (error instanceof TRPCError) {
      throw error
    }

    // Socket may have died — retry once with a fresh connection
    const msg = error instanceof Error ? error.message : ''
    if (msg.includes('socket') || msg.includes('ended') || msg.includes('EPIPE') || msg.includes('ECONNRESET')) {
      console.warn(`[hardware] Socket error, reconnecting: ${msg}`)
      try {
        client.disconnect()
        await client.connect()
        return await callback(client)
      } catch (retryError) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `${errorMessage}: ${retryError instanceof Error ? retryError.message : 'Reconnect failed'}`,
          cause: retryError,
        })
      }
    }

    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `${errorMessage}: ${msg || 'Unknown error'}`,
      cause: error,
    })
  }
}
