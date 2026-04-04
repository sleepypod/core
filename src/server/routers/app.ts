import { z } from 'zod'
import { publicProcedure, router } from '@/src/server/trpc'
import { deviceRouter } from './device'
import { settingsRouter } from './settings'
import { schedulesRouter } from './schedules'
import { biometricsRouter } from './biometrics'
import { healthRouter } from './health'
import { systemRouter } from './system'
import { environmentRouter } from './environment'
import { rawRouter } from './raw'
import { calibrationRouter } from './calibration'
import { waterLevelRouter } from './waterLevel'
import { runOnceRouter } from './runOnce'
import { scheduleGroupsRouter } from './scheduleGroups'

export const appRouter = router({
  healthcheck: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/healthcheck', protect: false, tags: ['Health'] } })
    .input(z.object({}))
    .output(z.string())
    .query(() => 'yay!'),

  device: deviceRouter,
  settings: settingsRouter,
  schedules: schedulesRouter,
  biometrics: biometricsRouter,
  health: healthRouter,
  // NOTE: systemRouter uses publicProcedure — acceptable because the pod runs on an
  // isolated LAN with WAN blocked by iptables. If internet access is ever opened,
  // add auth middleware before exposing these endpoints. See GitHub issue.
  system: systemRouter,
  environment: environmentRouter,
  raw: rawRouter,
  calibration: calibrationRouter,
  waterLevel: waterLevelRouter,
  runOnce: runOnceRouter,
  scheduleGroups: scheduleGroupsRouter,
})

export type AppRouter = typeof appRouter
