import { describe, expect, it } from 'vitest'
import { buildMaintenanceStatus, maintenanceStatusSchema, type MaintenanceSnapshot } from '../statusContract'
import { parseDeviceStatus } from '@/src/hardware/responseParser'
import { DEVICE_STATUS_POD4 } from '@/src/hardware/tests/fixtures'
import type { DeviceStatus } from '@/src/hardware/types'

function snapshot(): MaintenanceSnapshot & { status: DeviceStatus } {
  const now = Date.parse('2026-10-29T20:00:00Z')
  const status = parseDeviceStatus(DEVICE_STATUS_POD4)
  status.isPriming = false
  status.waterLevel = 'ok'
  status.leftSide.heatingDuration = status.rightSide.heatingDuration = 0
  return { now, revision: 'abcdef123', status, observedAt: now - 500, current: true, privacyBoundary: 'personal_required' }
}

describe('administrative maintenance projection', () => {
  it('reports only aggregate readiness after personal activation', () => {
    expect(buildMaintenanceStatus(snapshot())).toEqual({
      apiVersion: 1, kind: 'sleepypod-maintenance-status', generatedAt: '2026-10-29T20:00:00.000Z',
      controller: { id: 'sleepypod-core', revision: 'abcdef123' }, device: { freshness: 'fresh' },
      temperatureRuntime: 'ready', thermalIdle: true, privacyBoundary: 'personal_required',
    })
    expect(maintenanceStatusSchema.safeParse({ ...buildMaintenanceStatus(snapshot()), names: ['private'] }).success).toBe(false)
  })

  it.each(['leftSide', 'rightSide'] as const)('detects active heating on %s without releasing side identity', (side) => {
    const input = snapshot()
    input.status[side].heatingDuration = 1
    expect(buildMaintenanceStatus(input)).toMatchObject({ thermalIdle: false, temperatureRuntime: 'ready' })
    const text = JSON.stringify(buildMaintenanceStatus(input))
    for (const field of ['left', 'right', 'Temperature', 'sensorLabel', 'gestures', 'heatingDuration']) expect(text).not.toContain(field)
  })

  it.each([null, -1, Number.NaN, Infinity, '0', undefined])('does not assert idle for malformed countdown %s', (duration) => {
    const input = snapshot()
    Object.assign(input.status.rightSide, { heatingDuration: duration })
    expect(buildMaintenanceStatus(input)).toMatchObject({ thermalIdle: null, temperatureRuntime: 'not_ready' })
  })

  it.each([null, 0, Number.NaN, Infinity, 0.5, Date.parse('2026-10-29T20:00:01Z')])('withholds readiness for invalid or future timestamp %s', (observedAt) => {
    expect(buildMaintenanceStatus({ ...snapshot(), observedAt })).toMatchObject({ device: { freshness: 'unavailable' }, thermalIdle: null, temperatureRuntime: 'not_ready' })
  })

  it('withdraws readiness after a write invalidation or at the freshness deadline', () => {
    const input = snapshot()
    for (const changed of [{ ...input, current: false }, { ...input, observedAt: input.now - 15_000 }]) {
      expect(buildMaintenanceStatus(changed)).toMatchObject({ device: { freshness: 'stale' }, thermalIdle: null, temperatureRuntime: 'not_ready' })
    }
    expect(buildMaintenanceStatus({ ...input, status: null })).toMatchObject({ device: { freshness: 'unavailable' }, thermalIdle: null })
  })

  it('treats priming, water readiness and unknown privacy separately from thermal idleness', () => {
    const input = snapshot()
    input.status.isPriming = true
    expect(buildMaintenanceStatus(input)).toMatchObject({ thermalIdle: false, temperatureRuntime: 'not_ready' })
    input.status.isPriming = false
    input.status.waterLevel = 'low'
    expect(buildMaintenanceStatus(input)).toMatchObject({ thermalIdle: true, temperatureRuntime: 'not_ready' })
    expect(buildMaintenanceStatus({ ...input, privacyBoundary: 'unavailable' })).toMatchObject({ thermalIdle: null, temperatureRuntime: 'not_ready' })
  })
})
