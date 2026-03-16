/**
 * Shared helper functions for tRPC routers
 * Extracting common patterns to reduce code duplication
 */
import { TRPCError } from '@trpc/server'
import { createHardwareClient, type HardwareClient } from '@/src/hardware/client'

const DAC_SOCK_PATH = process.env.DAC_SOCK_PATH || '/run/dac.sock'

/**
 * Execute a callback with a hardware client connection.
 * Automatically handles connection setup, error wrapping, and cleanup.
 *
 * Pattern extracted from device router to eliminate repeated try-catch-finally blocks.
 * Each operation creates a new connection for hardware isolation and simplicity.
 *
 * @param callback - Async function that receives the hardware client
 * @param errorMessage - Custom error message prefix for TRPCError
 * @returns Result from the callback
 * @throws {TRPCError} INTERNAL_SERVER_ERROR if hardware operations fail
 *
 * @example
 * ```typescript
 * return withHardwareClient(
 *   async (client) => {
 *     return await client.getDeviceStatus()
 *   },
 *   'Failed to get device status'
 * )
 * ```
 */
export async function withHardwareClient<T>(
  callback: (client: HardwareClient) => Promise<T>,
  errorMessage: string
): Promise<T> {
  const client = await createHardwareClient({
    socketPath: DAC_SOCK_PATH,
    autoReconnect: true,
  })

  try {
    return await callback(client)
  }
  catch (error) {
    // If error is already a TRPCError, preserve it
    if (error instanceof TRPCError) {
      throw error
    }

    // Otherwise wrap in TRPCError with context
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `${errorMessage}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      cause: error,
    })
  }
  finally {
    client.disconnect()
  }
}
