import { base } from './base'
import { archivePush } from './archivePush'
import { automations } from './automations'
import { biometrics } from './biometrics'
import { calibration } from './calibration'
import { databases } from './databases'
import { device } from './device'
import { environment } from './environment'
import { health } from './health'
import { homekit } from './homekit'
import { mqtt } from './mqtt'
import { pumpAlerts } from './pumpAlerts'
import { raw } from './raw'
import { runOnce } from './runOnce'
import { schedules } from './schedules'
import { settings } from './settings'
import { system } from './system'
import { waterLevel } from './waterLevel'

export const demoRouters = {
  base,
  archivePush,
  automations,
  biometrics,
  calibration,
  databases,
  device,
  environment,
  health,
  homekit,
  mqtt,
  pumpAlerts,
  raw,
  runOnce,
  schedules,
  settings,
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
