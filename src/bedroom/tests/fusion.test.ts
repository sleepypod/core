import { describe, expect, it } from 'vitest'
import { bedroomConfigSchema, bedroomReportSchema, bedroomSourceSchema, type BedroomMetric, type BedroomObservation } from '../contract'
import { bedroomComfortGuidance, combineBedroomSensors } from '../fusion'

const now = 1793067000000
function reading(id: string, metric: BedroomMetric, value: number, change: Partial<BedroomObservation> = {}): BedroomObservation {
  return {
    source: bedroomSourceSchema.parse({ id, deviceId: id, deviceName: id, label: metric, provider: 'home_assistant',
      externalId: `sensor.${id}`, metric, unit: metric === 'temperature' ? '°F' : metric === 'pm25' ? 'µg/m³' : '%',
      maxAgeSeconds: 120, enabled: true, useForControl: true }),
    status: 'fresh', value, lastValue: value, unit: metric === 'temperature' ? '°F' : '%',
    observedAt: now - 1000, measuredAt: now - 1000, receivedAt: now, expiresAt: now + 119000,
    timeBasis: 'measurement', controlEligible: true, ...change,
  }
}

describe('bedroom sensor agreement', () => {
  it('combines independent bedside and room sources and reports their identities', () => {
    const readings = [reading('left', 'temperature', 76), reading('right', 'temperature', 77), reading('monitor', 'temperature', 78), reading('humidity', 'humidity', 50)]
    const result = combineBedroomSensors(readings, now)
    expect(result[0]).toMatchObject({ status: 'ready', value: 77, spread: 2, sourceIds: ['left', 'right', 'monitor'] })
    expect(bedroomComfortGuidance(result, now)).toMatchObject({ state: 'ready', offsetF: -1 })
    expect(bedroomComfortGuidance(result, now + 120000)).toMatchObject({ state: 'unavailable', offsetF: 0 })
  })
  it('withholds conflicting readings instead of averaging away disagreement', () => {
    const result = combineBedroomSensors([reading('left', 'temperature', 62), reading('right', 'temperature', 80), reading('humidity', 'humidity', 50)], now)
    expect(result[0]).toMatchObject({ status: 'disagreement', value: null, spread: 18 })
    expect(bedroomComfortGuidance(result, now).state).toBe('disagreement')
  })
  it.each([
    { status: 'cached' as const }, { status: 'stale' as const }, { controlEligible: false },
    { expiresAt: now }, { observedAt: now + 1 }, { value: NaN },
  ])('does not turn excluded readings into a control input: %j', (change) => {
    expect(combineBedroomSensors([reading('monitor', 'temperature', 78, change)], now)[0].status).toBe('unavailable')
  })
  it('does not count a second integration of the same physical sensor twice', () => {
    const first = reading('monitor', 'temperature', 70)
    const duplicate = { ...first, value: 73, source: { ...first.source, id: 'other_bridge' } }
    expect(combineBedroomSensors([first, duplicate, reading('left', 'temperature', 72)], now)[0])
      .toMatchObject({ value: 71, sourceIds: ['monitor', 'left'] })
    expect(bedroomConfigSchema.safeParse({ enabled: true, roomName: 'Bedroom', sources: [first.source, duplicate.source] }).success).toBe(false)
  })
  it('keeps air quality separate from thermal guidance and uses the worst particulate reading', () => {
    const result = combineBedroomSensors([reading('temp', 'temperature', 70), reading('rh', 'humidity', 50), reading('particles1', 'pm25', 5), reading('particles2', 'pm25', 55)], now)
    expect(result.find(item => item.metric === 'pm25')?.value).toBe(55)
    expect(bedroomComfortGuidance(result, now).offsetF).toBe(0)
  })
  it('requires an actual measurement time when a publisher claims measured data', () => {
    expect(bedroomReportSchema.safeParse({ schemaVersion: 1, revision: 1, sourceId: 'monitor', available: true,
      value: 72, observedAt: now, measuredAt: null, timeBasis: 'measurement' }).success).toBe(false)
  })
})
