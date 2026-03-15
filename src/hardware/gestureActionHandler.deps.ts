import { and, eq } from 'drizzle-orm'
import { db } from '@/src/db'
import { deviceState, tapGestures } from '@/src/db/schema'
import type { Side } from './types'
import type { GestureActionDeps } from './gestureActionHandler'
import type { GestureEvent } from './dacMonitor'
import { getSharedHardwareClient } from './dacMonitor.instance'

/**
 * Production dependency implementations for GestureActionHandler.
 * Kept in a separate file so the pure handler class can be unit-tested
 * without pulling in the database layer.
 */
export const defaultGestureActionDeps: GestureActionDeps = {
  findGestureConfig: async (side: Side, tapType: GestureEvent['tapType']) => {
    const [row] = await db
      .select()
      .from(tapGestures)
      .where(and(eq(tapGestures.side, side), eq(tapGestures.tapType, tapType)))
      .limit(1)
    return row ?? null
  },

  findDeviceState: async (side: Side) => {
    const [row] = await db
      .select()
      .from(deviceState)
      .where(eq(deviceState.side, side))
      .limit(1)
    return row ?? null
  },

  newHardwareClient: (_socketPath: string) =>
    getSharedHardwareClient(),
}
