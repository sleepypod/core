import { publicProcedure, router } from '@/src/server/trpc'
import { deviceRouter } from './device'
import { settingsRouter } from './settings'
import { schedulesRouter } from './schedules'
import { biometricsRouter } from './biometrics'

export const appRouter = router({
  healthcheck: publicProcedure.query(() => 'yay!'),

  device: deviceRouter,
  settings: settingsRouter,
  schedules: schedulesRouter,
  biometrics: biometricsRouter,
})

export type AppRouter = typeof appRouter
