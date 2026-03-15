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

    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `${errorMessage}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      cause: error,
    })
  }
}
