import type { DemoHandlers, RouterOutputs } from '../types'
import { HOUR, MINUTE } from '../util'

type Alert = RouterOutputs['pumpAlerts']['list'][number]

// One harmless warning so the alerts card has something to dismiss.
const alerts: Alert[] = [
  {
    id: 1,
    timestamp: new Date(Date.now() - 9 * HOUR - 12 * MINUTE),
    type: 'asymmetry',
    side: null,
    rpm: null,
    flowrateCd: 2412,
    durationSeconds: 340,
    action: 'warned',
    restoreTargetTemperature: null,
    restoreDurationSeconds: null,
    acknowledgedAt: null,
    dismissedAt: null,
  },
]

export const pumpAlerts: DemoHandlers<'pumpAlerts'> = {
  list: input => alerts
    .filter(a => a.dismissedAt === null && (input.includeAcknowledged || a.acknowledgedAt === null))
    .slice(0, input.limit ?? 50),

  getCapabilities: () => ({ hasBedCenterSensors: true }),

  acknowledgeAndRestore: () => ({ success: true, restoredTarget: null, restoredDuration: null, orphanRecovered: false }),

  dismissNotification: () => ({ success: true }),

  dismissAlert: (input) => {
    const alert = alerts.find(a => a.id === input.id && a.dismissedAt === null)
    if (!alert) throw new Error(`Pump alert ${input.id} not found or already dismissed`)
    alert.dismissedAt = new Date()
    return { success: true }
  },
}
