import { publicProcedure, router } from '@/src/server/trpc'
import { deviceRouter } from './device'
import { settingsRouter } from './settings'
import { schedulesRouter } from './schedules'
import { biometricsRouter } from './biometrics'
import { healthRouter } from './health'

export const appRouter = router({
  healthcheck: publicProcedure.query(() => 'yay!'),

  device: deviceRouter,
  settings: settingsRouter,
  schedules: schedulesRouter,
  biometrics: biometricsRouter,
  health: healthRouter,
})

export type AppRouter = typeof appRouter
