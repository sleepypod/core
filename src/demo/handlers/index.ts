import { base } from './base'
import { bedroom } from './bedroom'
import { archivePush } from './archivePush'
import { automations } from './automations'
import { biometrics } from './biometrics'
import { biometricShadow } from './biometricShadow'
import { biometricTuning } from './biometricTuning'
import { calibration } from './calibration'
import { comfort } from './comfort'
import { controls } from './controls'
import { curveTemplates } from './curveTemplates'
import { databases } from './databases'
import { device } from './device'
import { environment } from './environment'
import { health } from './health'
import { homekit } from './homekit'
import { nextAlarm } from './nextAlarm'
import { journal } from './journal'
import { importedHistory } from './importedHistory'
import { mqtt } from './mqtt'
import { notifications } from './notifications'
import { roomContext } from './roomContext'
import { pumpAlerts } from './pumpAlerts'
import { raw } from './raw'
import { runOnce } from './runOnce'
import { routines } from './routines'
import { schedules } from './schedules'
import { settings } from './settings'
import { sleepStages } from './sleepStages'
import { system } from './system'
import { waterLevel } from './waterLevel'

export const demoRouters = {
  base,
  bedroom,
  archivePush,
  automations,
  biometrics,
  biometricTuning,
  biometricShadow,
  calibration,
  comfort,
  controls,
  curveTemplates,
  databases,
  device,
  environment,
  health,
  homekit,
  importedHistory,
  journal,
  nextAlarm,
  mqtt,
  notifications,
  roomContext,
  pumpAlerts,
  raw,
  runOnce,
  routines,
  schedules,
  settings,
  sleepStages,
  system,
  waterLevel,
} as const

type AnyHandler = (input: unknown) => unknown

export async function resolveDemoCall(path: string, input: unknown): Promise<unknown> {
  const [routerName, procedure] = path.split('.')
  const router = demoRouters[routerName as keyof typeof demoRouters] as Record<string, AnyHandler | undefined> | undefined
  const handler = router?.[procedure]
  if (!handler) throw new Error(`Not available in the demo (${path})`)
  return handler(input)
}
