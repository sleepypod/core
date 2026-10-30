import { z } from 'zod'
import { DEVICE_FRESHNESS_MS } from '@/src/capabilities/contract'
import type { DeviceStatus } from '@/src/hardware/types'
import type { LegacyPrivacyState } from '@/src/household/legacyPrivacy'

export const maintenanceStatusSchema = z.strictObject({
  apiVersion: z.literal(1),
  kind: z.literal('sleepypod-maintenance-status'),
  generatedAt: z.iso.datetime(),
  controller: z.strictObject({
    id: z.literal('sleepypod-core'),
    revision: z.string().regex(/^[a-f0-9]{7,40}$/).nullable(),
  }),
  device: z.strictObject({ freshness: z.enum(['fresh', 'stale', 'unavailable']) }),
  temperatureRuntime: z.enum(['ready', 'not_ready']),
  thermalIdle: z.boolean().nullable(),
  privacyBoundary: z.enum(['legacy', 'personal_required', 'unavailable']),
})
export type MaintenanceStatus = z.infer<typeof maintenanceStatusSchema>

export interface MaintenanceSnapshot {
  now: number
  revision: string | null
  status: DeviceStatus | null
  observedAt: number | null
  current: boolean
  privacyBoundary: LegacyPrivacyState
}

/** Maintenance sees whole-controller readiness, never a sleeper or a side's measurements. */
export function buildMaintenanceStatus(snapshot: MaintenanceSnapshot): MaintenanceStatus {
  const { now, status, observedAt, current, privacyBoundary } = snapshot
  const validObservation = status !== null && observedAt !== null && Number.isSafeInteger(observedAt) && observedAt > 0 && observedAt <= now
  const freshness = !validObservation ? 'unavailable' : current && now - observedAt < DEVICE_FRESHNESS_MS ? 'fresh' : 'stale'
  const durations = [status?.leftSide?.heatingDuration, status?.rightSide?.heatingDuration]
  const validThermal = freshness === 'fresh' && typeof status?.isPriming === 'boolean'
    && durations.every(duration => typeof duration === 'number' && Number.isFinite(duration) && duration >= 0)
  const readable = privacyBoundary !== 'unavailable'
  return maintenanceStatusSchema.parse({
    apiVersion: 1,
    kind: 'sleepypod-maintenance-status',
    generatedAt: new Date(now).toISOString(),
    controller: { id: 'sleepypod-core', revision: snapshot.revision },
    device: { freshness },
    temperatureRuntime: readable && validThermal && status?.waterLevel === 'ok' && status.isPriming === false ? 'ready' : 'not_ready',
    thermalIdle: readable && validThermal ? status?.isPriming === false && durations.every(duration => duration === 0) : null,
    privacyBoundary,
  })
}
