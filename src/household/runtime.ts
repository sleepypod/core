import { sqlite } from '@/src/db'
import { HouseholdStore } from './store'
import { householdHttp } from './http'
import { PersonalRuntime } from './personalRuntime'
import { PersonalRoutineService } from './personalRoutines'
import { ArrangementReviewService } from './arrangementReviews'
import { PersonHistoryStore } from './personHistory'
import { PersonalHistoryApi } from './historyApi'
import { assertControlCurrent } from '@/src/controls/context'
import { getTemperatureControllerIfRunning } from '@/src/temperature/instance'
import { withSideLock } from '@/src/hardware/sideLock'
const shared = globalThis as typeof globalThis & {
  __sleepypodHousehold?: {
    store: HouseholdStore
    personalRuntime?: PersonalRuntime
    personalRoutines?: PersonalRoutineService
    arrangementReviews?: ArrangementReviewService
    personalHistory?: PersonalHistoryApi
    publicAttempts: number
    windowStarted: number
  }
}
export function preparationEnabled() {
  return process.env.SLEEPYPOD_HOUSEHOLD_PREPARATION === '1'
}
export async function handleHouseholdRequest(request: Request) {
  if (!preparationEnabled())
    return Response.json({ error: { code: 'not_ready', message: 'Personal household preparation is not enabled on this controller.' } }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } })
  const runtime = shared.__sleepypodHousehold ??= { store: new HouseholdStore(sqlite), publicAttempts: 0, windowStarted: Date.now() }
  runtime.personalRuntime ??= new PersonalRuntime({ database: sqlite, identities: runtime.store,
    enabled: () => process.env.SLEEPYPOD_PERSONAL_RUNTIME === '1',
    observe: async () => {
      const { getDacMonitorIfRunning } = await import('@/src/hardware/dacMonitor.instance')
      const monitor = getDacMonitorIfRunning()
      const cached = monitor?.getFreshStatus(2_000)
      const cachedAt = monitor?.getLastPollAt()
      if (cached && cachedAt) return { status: cached, observedAt: cachedAt }
      const { getSharedHardwareClient } = await import('@/src/hardware/sharedClient')
      const client = getSharedHardwareClient()
      const observedAt = Date.now()
      await client.connect()
      return { status: await client.getDeviceStatus(), observedAt }
    },
    requestedTarget: side => getTemperatureControllerIfRunning()?.status(side).targetTemperature ?? null,
    execute: async (action) => {
      const { executeControlAction } = await import('@/src/controls/instance')
      assertControlCurrent()
      return executeControlAction(action)
    },
  })
  runtime.personalRoutines ??= new PersonalRoutineService({ database: sqlite, identities: runtime.store,
    authority: runtime.personalRuntime.authority, enabled: () => process.env.SLEEPYPOD_PERSONAL_ROUTINES === '1',
    withZones: (zones, operation) => zones.length === 2
      ? withSideLock('left', () => withSideLock('right', operation))
      : withSideLock(zones[0], operation),
    refreshScheduler: async (delta) => {
      const { applyRoutineSchedulerDelta } = await import('@/src/server/bedtimeRoutineStore')
      return applyRoutineSchedulerDelta(delta)
    },
  })
  runtime.arrangementReviews ??= new ArrangementReviewService({ database: sqlite, identities: runtime.store,
    enabled: () => process.env.SLEEPYPOD_ARRANGEMENT_REVIEW === '1' })
  runtime.personalHistory ??= new PersonalHistoryApi({ identities: runtime.store, history: new PersonHistoryStore(sqlite, runtime.store),
    enabled: () => preparationEnabled() && process.env.SLEEPYPOD_PERSONAL_HISTORY === '1' })
  return householdHttp(request, {
    store: runtime.store,
    personalRuntime: runtime.personalRuntime,
    personalRoutines: runtime.personalRoutines,
    arrangementReviews: runtime.arrangementReviews,
    personalHistory: runtime.personalHistory,
    verifySoloConfiguration: (side) => {
      const row = sqlite.prepare('SELECT bed_mode, unused_zone_mode FROM device_settings LIMIT 1').get() as {
        bed_mode: string
        unused_zone_mode: string
      } | undefined
      return row?.bed_mode === `solo-${side}` && row.unused_zone_mode === 'follow'
    },
    allowPublicAttempt: () => {
      const now = Date.now()
      if (now - runtime.windowStarted >= 60000 || now < runtime.windowStarted) {
        runtime.windowStarted = now
        runtime.publicAttempts = 0
      }
      runtime.publicAttempts += 1
      return runtime.publicAttempts <= 30
    },
  })
}
