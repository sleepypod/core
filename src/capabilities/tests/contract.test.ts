import { describe, expect, it } from 'vitest'
import { parseDeviceStatus } from '@/src/hardware/responseParser'
import { DEVICE_STATUS_POD4 } from '@/src/hardware/tests/fixtures'
import type { BaseStatus } from '@/src/hardware/base/types'
import type { DeviceStatus } from '@/src/hardware/types'
import { BASE_FRESHNESS_MS, DEVICE_FRESHNESS_MS, buildCapabilities, capabilitiesSchema, type CapabilitySnapshot } from '../contract'

const now = Date.parse('2026-10-25T20:00:00Z')
type PopulatedSnapshot = CapabilitySnapshot & { device: { status: DeviceStatus }, base: BaseStatus }
function snapshot(): PopulatedSnapshot {
  return {
    now, revision: 'abcdef0', mqttConnected: false,
    device: { status: parseDeviceStatus(DEVICE_STATUS_POD4), observedAt: now - 1000, current: true },
    base: {
      state: 'connected', independentControl: false, movingBySide: { left: false, right: false },
      splitBase: false, position: { left: { head: 0, feet: 0 }, right: { head: 0, feet: 0 } },
      lastUpdate: now - 1000, stale: false, moving: false, busy: false, error: null,
    },
  }
}

describe('capability evidence contract', () => {
  it('reports fresh runtime evidence without promoting it to physical qualification', () => {
    const result = buildCapabilities(snapshot())
    expect(capabilitiesSchema.parse(result)).toEqual(result)
    expect(result.features.temperatureControl).toMatchObject({ implemented: true, runtime: 'ready', physicalVerification: 'unverified' })
    expect(result.features.baseMovement).toMatchObject({ runtime: 'ready', physicalVerification: 'unverified' })
    expect(result.features.wakeVibration.physicalVerification).toBe('unverified')
    expect(result.observations.device).toEqual({ freshness: 'fresh', observedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now - 1000 + DEVICE_FRESHNESS_MS).toISOString() })
    expect(result.baseScope).toBe('whole_bed')
    expect(result.features.alarmSnooze).toMatchObject({ implemented: true, runtime: 'ready', physicalVerification: 'not_applicable' })
    expect(result.features.curveLibrary).toMatchObject({ implemented: true, runtime: 'ready', reason: 'calendar_curves_with_bedtime_ownership_guard' })
    expect(result.features.personalStageModels).toMatchObject({ implemented: true, runtime: 'ready', physicalVerification: 'not_applicable' })
    expect(result.features.importedHistory).toMatchObject({ implemented: true, runtime: 'ready', reason: 'read_only_history_api_check_snapshot_availability' })
    expect(result.endpoints.importedHistory).toBe('/api/v1/history')
    expect(result.endpoints.temperatureApplications).toBe('/api/v1/device/temperature/applications')
    expect(result.features.temperatureApplicationHistory).toMatchObject({ implemented: true, runtime: 'ready', physicalVerification: 'not_applicable' })
    expect(result.controlSemantics).toEqual({ acknowledgment: 'accepted_not_physically_verified', durableCommandReceipts: true, commandExpiry: true, receiptScope: 'versioned_controls_only', maxLifetimeMs: 60000 })
  })

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY, -1, 0, now + 1, now - 0.5])('rejects invalid or future observation time %s', (timestamp) => {
    const input = snapshot()
    input.device.observedAt = timestamp
    input.base.lastUpdate = timestamp
    const result = buildCapabilities(input)
    expect(result.observations.device.freshness).toBe('unavailable')
    expect(result.observations.base.freshness).toBe('unavailable')
    expect(result.features.temperatureControl.runtime).toBe('not_ready')
    expect(result.features.baseMovement.runtime).toBe('not_ready')
    expect(result.features.baseStop.runtime).toBe('ready')
  })

  it('expires observations exactly at the freshness boundary', () => {
    const input = snapshot()
    input.device.observedAt = now - DEVICE_FRESHNESS_MS
    input.base.lastUpdate = now - BASE_FRESHNESS_MS
    const result = buildCapabilities(input)
    expect(result.observations.device.freshness).toBe('stale')
    expect(result.observations.base.freshness).toBe('stale')
    expect(result.features.wakeVibration.runtime).toBe('not_ready')
    expect(result.features.baseStop.runtime).toBe('ready')
  })

  it('withdraws readiness after disconnect or an invalidated DAC observation', () => {
    const input = snapshot()
    input.device.current = false
    input.base.state = 'disconnected'
    const result = buildCapabilities(input)
    expect(result.observations.device.freshness).toBe('stale')
    expect(result.observations.base.freshness).toBe('stale')
    expect(result.features.baseStop.runtime).toBe('not_ready')
  })

  it.each<Partial<BaseStatus>>([{ busy: true }, { moving: true }, { moving: null }, { stale: true }, { position: null }])('keeps Stop available when movement cannot be offered: %s', (changes) => {
    const input = snapshot()
    Object.assign(input.base, changes)
    const result = buildCapabilities(input)
    expect(result.features.baseMovement.runtime).toBe('not_ready')
    expect(result.features.baseStop.runtime).toBe('ready')
  })

  it('withholds thermal readiness for low water and priming', () => {
    const input = snapshot()
    input.device.status.waterLevel = 'low'
    expect(buildCapabilities(input).features.temperatureControl.reason).toBe('water_not_ready')
    input.device.status.isPriming = true
    const result = buildCapabilities(input)
    expect(result.features.temperatureControl.reason).toBe('priming')
    expect(result.features.wakeVibration.runtime).toBe('not_ready')
    expect(result.features.deviceTelemetry.runtime).toBe('ready')
  })

  it('reports absent hardware and unimplemented integrations honestly', () => {
    const input: CapabilitySnapshot = snapshot()
    input.device.status = null
    input.base = null
    const result = buildCapabilities(input)
    expect(result.features.deviceTelemetry.runtime).toBe('not_ready')
    expect(result.features.basePosition.runtime).toBe('not_ready')
    for (const key of ['nativeCompatibility', 'musicVibration'] as const) {
      expect(result.features[key]).toMatchObject({ implemented: false, runtime: 'not_ready' })
    }
    expect(result.endpoints.nativeCompatibility).toBeNull()
    expect(result.features.personalComfort).toMatchObject({ implemented: true, runtime: 'not_ready', physicalVerification: 'unverified' })
    expect(result.features.personalComfortOwnerReview?.implemented).toBe(true)
    expect(result.features.mqtt.runtime).toBe('not_ready')
    input.mqttConnected = true
    expect(buildCapabilities(input).features.mqtt.runtime).toBe('ready')
    expect(buildCapabilities(input).features.homeContext.runtime).toBe('not_ready')
    expect(result.features.homeContext.implemented).toBe(true)
    input.roomContextFresh = true
    expect(buildCapabilities(input).features.homeContext).toMatchObject({ runtime: 'ready', reason: 'fresh_mapped_room_measurements' })
  })
})
