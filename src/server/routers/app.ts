import { baseRouter } from './base'
import { z } from 'zod'
import { publicProcedure, router } from '@/src/server/trpc'
import { deviceRouter } from './device'
import { settingsRouter } from './settings'
import { schedulesRouter } from './schedules'
import { routinesRouter } from './routines'
import { biometricsRouter } from './biometrics'
import { healthRouter } from './health'
import { systemRouter } from './system'
import { environmentRouter } from './environment'
import { rawRouter } from './raw'
import { calibrationRouter } from './calibration'
import { waterLevelRouter } from './waterLevel'
import { pumpAlertsRouter } from './pumpAlerts'
import { runOnceRouter } from './runOnce'
import { mqttRouter } from './mqtt'
import { homekitRouter } from './homekit'
import { archivePushRouter } from './archivePush'
import { automationsRouter } from './automations'
import { databasesRouter } from './databases'
import { sleepStagesRouter } from './sleepStages'
import { curveTemplatesRouter } from './curveTemplates'
import { biometricTuningRouter } from './biometricTuning'
import { biometricShadowRouter } from './biometricShadow'
import { capabilitiesRouter } from './capabilities'
import { comfortRouter } from './comfort'
import { controlsRouter } from './controls'
import { notificationsRouter } from './notifications'
import { roomContextRouter } from './roomContext'
import { bedroomRouter } from './bedroom'
import { nextAlarmRouter } from './nextAlarm'
import { journalRouter } from './journal'
import { importedHistoryRouter } from './importedHistory'

export const appRouter = router({
  healthcheck: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/healthcheck', protect: false, tags: ['Health'] } })
    .input(z.object({}))
    .output(z.string())
    .query(() => 'yay!'),

  device: deviceRouter,
  base: baseRouter,
  settings: settingsRouter,
  schedules: schedulesRouter,
  routines: routinesRouter,
  biometrics: biometricsRouter,
  health: healthRouter,
  // REST and tRPC entry points authenticate owner requests before dispatch.
  system: systemRouter,
  capabilities: capabilitiesRouter,
  comfort: comfortRouter,
  controls: controlsRouter,
  notifications: notificationsRouter,
  roomContext: roomContextRouter,
  bedroom: bedroomRouter,
  importedHistory: importedHistoryRouter,
  journal: journalRouter,
  nextAlarm: nextAlarmRouter,
  environment: environmentRouter,
  raw: rawRouter,
  calibration: calibrationRouter,
  waterLevel: waterLevelRouter,
  pumpAlerts: pumpAlertsRouter,
  runOnce: runOnceRouter,
  mqtt: mqttRouter,
  homekit: homekitRouter,
  archivePush: archivePushRouter,
  automations: automationsRouter,
  databases: databasesRouter,
  sleepStages: sleepStagesRouter,
  curveTemplates: curveTemplatesRouter,
  biometricTuning: biometricTuningRouter,
  biometricShadow: biometricShadowRouter,
})

export type AppRouter = typeof appRouter
