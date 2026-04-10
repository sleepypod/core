import { z } from 'zod'
import { publicProcedure, router } from '@/src/server/trpc'

export const miniRouter = router({
  status: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/mini/status', protect: false, tags: ['Mini'] } })
    .input(z.object({}))
    .output(z.object({ enabled: z.boolean() }))
    .query(() => ({ enabled: true })),

  devices: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/mini/devices', protect: false, tags: ['Mini'] } })
    .input(z.object({}))
    .output(z.object({
      devices: z.array(z.object({
        serialNumber: z.string(),
        firmwareVersion: z.string(),
        timezone: z.string(),
      })),
    }))
    .query(async () => {
      const { SnooClient } = await import('@/src/services/mini')
      const client = new SnooClient()
      const devices = await client.getDevices()
      return {
        devices: devices.map(d => ({
          serialNumber: d.serialNumber,
          firmwareVersion: d.firmwareVersion,
          timezone: d.timezone,
        })),
      }
    }),

  baby: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/mini/baby', protect: false, tags: ['Mini'] } })
    .input(z.object({}))
    .output(z.object({
      babyName: z.string(),
      birthDate: z.string().nullable(),
      settings: z.object({
        responsivenessLevel: z.string(),
        motionLimiter: z.boolean(),
        weaning: z.boolean(),
      }),
    }))
    .query(async () => {
      const { SnooClient } = await import('@/src/services/mini')
      const client = new SnooClient()
      const baby = await client.getBaby()
      return {
        babyName: baby.babyName,
        birthDate: baby.birthDate,
        settings: {
          responsivenessLevel: baby.settings.responsivenessLevel,
          motionLimiter: baby.settings.motionLimiter,
          weaning: baby.settings.weaning,
        },
      }
    }),
})
