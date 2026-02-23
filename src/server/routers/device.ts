import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { createHardwareClient } from '@/src/hardware/client'
import { db } from '@/src/db'
import { deviceState } from '@/src/db/schema'
import { eq } from 'drizzle-orm'

const DAC_SOCK_PATH = process.env.DAC_SOCK_PATH || '/run/dac.sock'

/**
 * Device control router - handles real-time pod operations
 */
export const deviceRouter = router({
  /**
   * Get current device status from hardware
   */
  getStatus: publicProcedure.query(async () => {
    const client = await createHardwareClient({
      socketPath: DAC_SOCK_PATH,
      autoReconnect: true,
    })

    try {
      const status = await client.getDeviceStatus()

      // Update database with current state
      // Note: Using separate updates instead of bulk insert to ensure correct conflict resolution
      await db
        .insert(deviceState)
        .values({
          side: 'left',
          currentTemperature: status.leftSide.currentTemperature,
          targetTemperature: status.leftSide.targetTemperature,
          isPowered: status.leftSide.targetLevel !== 0,
          lastUpdated: new Date(),
        })
        .onConflictDoUpdate({
          target: deviceState.side,
          set: {
            currentTemperature: status.leftSide.currentTemperature,
            targetTemperature: status.leftSide.targetTemperature,
            isPowered: status.leftSide.targetLevel !== 0,
            lastUpdated: new Date(),
          },
        })

      await db
        .insert(deviceState)
        .values({
          side: 'right',
          currentTemperature: status.rightSide.currentTemperature,
          targetTemperature: status.rightSide.targetTemperature,
          isPowered: status.rightSide.targetLevel !== 0,
          lastUpdated: new Date(),
        })
        .onConflictDoUpdate({
          target: deviceState.side,
          set: {
            currentTemperature: status.rightSide.currentTemperature,
            targetTemperature: status.rightSide.targetTemperature,
            isPowered: status.rightSide.targetLevel !== 0,
            lastUpdated: new Date(),
          },
        })

      return status
    }
    catch (error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Failed to get device status: ${error instanceof Error ? error.message : 'Unknown error'}`,
        cause: error,
      })
    }
    finally {
      client.disconnect()
    }
  }),

  /**
   * Set temperature for a side
   */
  setTemperature: publicProcedure
    .input(
      z.object({
        side: z.enum(['left', 'right']),
        temperature: z.number().min(55).max(110),
        duration: z.number().min(0).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const client = await createHardwareClient({
        socketPath: DAC_SOCK_PATH,
      })

      try {
        await client.setTemperature(input.side, input.temperature, input.duration)

        // Update database
        await db
          .update(deviceState)
          .set({
            targetTemperature: input.temperature,
            isPowered: true,
            lastUpdated: new Date(),
          })
          .where(eq(deviceState.side, input.side))

        return { success: true }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to set temperature: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
      finally {
        client.disconnect()
      }
    }),

  /**
   * Set power state for a side
   */
  setPower: publicProcedure
    .input(
      z.object({
        side: z.enum(['left', 'right']),
        powered: z.boolean(),
        temperature: z.number().min(55).max(110).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const client = await createHardwareClient({
        socketPath: DAC_SOCK_PATH,
      })

      try {
        await client.setPower(input.side, input.powered, input.temperature)

        // Update database
        await db
          .update(deviceState)
          .set({
            isPowered: input.powered,
            ...(input.temperature && { targetTemperature: input.temperature }),
            lastUpdated: new Date(),
          })
          .where(eq(deviceState.side, input.side))

        return { success: true }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to set power: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
      finally {
        client.disconnect()
      }
    }),

  /**
   * Set alarm for a side
   */
  setAlarm: publicProcedure
    .input(
      z.object({
        side: z.enum(['left', 'right']),
        vibrationIntensity: z.number().min(1).max(100),
        vibrationPattern: z.enum(['double', 'rise']),
        duration: z.number().min(0).max(180),
      })
    )
    .mutation(async ({ input }) => {
      const client = await createHardwareClient({
        socketPath: DAC_SOCK_PATH,
      })

      try {
        await client.setAlarm(input.side, {
          vibrationIntensity: input.vibrationIntensity,
          vibrationPattern: input.vibrationPattern,
          duration: input.duration,
        })

        // Update database
        await db
          .update(deviceState)
          .set({
            isAlarmVibrating: true,
            lastUpdated: new Date(),
          })
          .where(eq(deviceState.side, input.side))

        return { success: true }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to set alarm: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
      finally {
        client.disconnect()
      }
    }),

  /**
   * Clear alarm for a side
   */
  clearAlarm: publicProcedure
    .input(
      z.object({
        side: z.enum(['left', 'right']),
      })
    )
    .mutation(async ({ input }) => {
      const client = await createHardwareClient({
        socketPath: DAC_SOCK_PATH,
      })

      try {
        await client.clearAlarm(input.side)

        // Update database
        await db
          .update(deviceState)
          .set({
            isAlarmVibrating: false,
            lastUpdated: new Date(),
          })
          .where(eq(deviceState.side, input.side))

        return { success: true }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to clear alarm: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
      finally {
        client.disconnect()
      }
    }),

  /**
   * Start pod priming sequence
   */
  startPriming: publicProcedure.mutation(async () => {
    const client = await createHardwareClient({
      socketPath: DAC_SOCK_PATH,
    })

    try {
      await client.startPriming()
      return { success: true }
    }
    catch (error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Failed to start priming: ${error instanceof Error ? error.message : 'Unknown error'}`,
        cause: error,
      })
    }
    finally {
      client.disconnect()
    }
  }),
})
