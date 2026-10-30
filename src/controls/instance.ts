import { randomUUID } from 'node:crypto'
import { sqlite } from '@/src/db'
import { deviceRouter } from '@/src/server/routers/device'
import { baseRouter } from '@/src/server/routers/base'
import { createControlStore } from './store'
import { ControlService } from './service'
import type { ControlAction } from './contract'

/** Reuse the existing authority, locks, manual pause and hardware safety checks. */
export async function executeControlAction(action: ControlAction): Promise<unknown> {
  const device = deviceRouter.createCaller({})
  const base = baseRouter.createCaller({})
  switch (action.kind) {
    case 'temperature': return device.setTemperature({ side: action.side, temperature: action.temperature, holdMinutes: action.holdMinutes })
    case 'power': return device.setPower({ side: action.side, powered: action.powered, temperature: action.temperature })
    case 'vibration': return device.setAlarm({ side: action.side, vibrationIntensity: action.intensity, vibrationPattern: action.pattern, duration: action.duration })
    case 'vibration.clear': return device.clearAlarm({ side: action.side })
    case 'base.position': return base.setPosition({ head: action.head, feet: action.feet, feedRate: action.feedRate, sides: ['left', 'right'] })
    case 'base.stop': return base.stop({})
  }
}

const globals = globalThis as typeof globalThis & { __sp_controlService?: ControlService }
export function getControlService(): ControlService {
  return globals.__sp_controlService ??= new ControlService({ store: createControlStore(sqlite), execute: executeControlAction, runId: randomUUID() })
}
