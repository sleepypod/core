import { publicProcedure, router } from '@/src/server/trpc'
import { deviceRouter } from './device'
import { settingsRouter } from './settings'
import { schedulesRouter } from './schedules'
import { biometricsRouter } from './biometrics'
import { healthRouter } from './health'
import { systemRouter } from './system'

export const appRouter = router({
  healthcheck: publicProcedure.query(() => 'yay!'),

  device: deviceRouter,
  settings: settingsRouter,
  schedules: schedulesRouter,
  biometrics: biometricsRouter,
  health: healthRouter,
  // NOTE: systemRouter uses publicProcedure — acceptable because the pod runs on an
  // isolated LAN with WAN blocked by iptables. If internet access is ever opened,
  // add auth middleware before exposing these endpoints. See GitHub issue.
  system: systemRouter,
})

export type AppRouter = typeof appRouter
