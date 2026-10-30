// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { bedroomConfigSchema, bedroomSourceSchema } from '../contract'
import { createBedroomStore } from '../store'
import { receiveBedroomMqtt } from '../mqtt'

const start = 1793067000000
const source = bedroomSourceSchema.parse({ id: 'monitor_temperature', deviceId: 'monitor', deviceName: 'Air monitor',
  label: 'Room temperature', provider: 'home_assistant', externalId: 'sensor.monitor_temperature', metric: 'temperature',
  unit: '°C', maxAgeSeconds: 120, enabled: true, useForControl: true })
const config = bedroomConfigSchema.parse({ enabled: true, roomName: 'Bedroom', sources: [source] })
let database: ReturnType<typeof migratedComfortDatabase>, store: ReturnType<typeof createBedroomStore>, now: number
function report(change: Record<string, unknown> = {}) {
  return { schemaVersion: 1, revision: 1, sourceId: source.id, available: true, value: 24,
    observedAt: now, measuredAt: now - 1000, timeBasis: 'measurement', ...change }
}
beforeEach(() => {
  database = migratedComfortDatabase()
  now = start
  store = createBedroomStore(database, () => now)
  store.configure(config, 0)
})
afterEach(() => database.close())

describe('persisted bedroom inputs', () => {
  it('rejects broker replay and withdraws only broker-delivered readings when the connection is lost', () => {
    const packet = () => Buffer.from(JSON.stringify(report()))
    expect(receiveBedroomMqtt(store, packet(), { retain: false, dup: false })).toBe(false)
    store.connection(true, 'fixture/pod/bedroom/report')
    expect(receiveBedroomMqtt(store, packet(), { retain: true, dup: false })).toBe(false)
    expect(receiveBedroomMqtt(store, packet(), { retain: false, dup: true })).toBe(false)
    expect(receiveBedroomMqtt(store, packet(), { retain: false, dup: false })).toBe(true)
    expect(store.status().observations[0].status).toBe('fresh')
    store.connection(false)
    expect(store.signals()).toEqual({})
    store.connection(true, 'fixture/pod/bedroom/report')
    expect(store.status().observations[0].status).toBe('waiting')
    expect(receiveBedroomMqtt(store, packet(), { retain: false, dup: false })).toBe(false)
    now += 5000
    expect(store.receive(report()).accepted).toBe(true)
    store.connection(false)
    expect(store.status().observations[0].status).toBe('fresh')
  })
  it('uses source units, preserves measurement time and expires without a new packet', () => {
    expect(store.status().observations[0].status).toBe('waiting')
    expect(store.receive(report()).accepted).toBe(true)
    expect(store.status().observations[0]).toMatchObject({ value: 75.2, unit: '°F', measuredAt: start - 1000,
      observedAt: start, receivedAt: start, status: 'fresh', controlEligible: true })
    expect(store.signals()).toEqual({ 'room.temperature': 75.2 })
    now += 119000
    expect(store.status().observations[0]).toMatchObject({ value: null, lastValue: 75.2, status: 'stale', controlEligible: false })
    expect(store.signals()).toEqual({})
    expect(store.history().items[0].report.value).toBe(24)
    expect(store.history().items[0].source.unit).toBe('°C')
  })
  it('does not refresh cached values just because the bridge answered a query', () => {
    expect(store.receive(report({ timeBasis: 'cached', measuredAt: null })).accepted).toBe(true)
    expect(store.status().observations[0]).toMatchObject({ status: 'cached', value: null, lastValue: 75.2, controlEligible: false })
    expect(store.signals()).toEqual({})
  })
  it('distinguishes a confirmed device read from a hardware measurement timestamp', () => {
    expect(store.receive(report({ timeBasis: 'device_read', measuredAt: null })).accepted).toBe(true)
    expect(store.status().observations[0]).toMatchObject({ timeBasis: 'device_read', measuredAt: null, observedAt: start, expiresAt: start + 120000 })
  })
  it('does not reuse saved readings as live after restart or reconfigure', () => {
    const first = report()
    store.receive(first)
    store = createBedroomStore(database, () => now)
    expect(store.status().observations[0].status).toBe('waiting')
    expect(store.receive(first).accepted).toBe(false)
    now += 6000
    expect(store.receive(report({ measuredAt: start - 1000 })).reason).toBe('replayed_measurement')
    expect(store.receive(report()).accepted).toBe(true)
    expect(() => store.configure(config, 0)).toThrow(/changed/)
    store.configure(config, 1)
    expect(store.status().observations[0].status).toBe('waiting')
    expect(store.receive(report()).reason).toBe('configuration_changed')
  })
  it('withdraws an unavailable source immediately and preserves the measurement watermark', () => {
    store.receive(report())
    now += 1
    expect(store.receive(report({ available: false, value: null, measuredAt: null })).accepted).toBe(true)
    expect(store.status().observations[0].status).toBe('unavailable')
    now += 6000
    expect(store.receive(report({ measuredAt: start - 1000 })).reason).toBe('replayed_measurement')
    expect(store.signals()).toEqual({})
  })
  it.each([
    { value: 200 }, { value: NaN }, { value: '24' }, { available: false }, { sourceId: 'another' },
    { observedAt: start + 1 }, { observedAt: start - 30000, measuredAt: start - 31000 },
    { measuredAt: start - 120000 }, { measuredAt: start + 1 }, { revision: 2 }, { unexpected: 'field' },
  ])('rejects malformed, expired, unmapped and future observations: %j', (change) => {
    expect(store.receive(report(change)).accepted).toBe(false)
    expect(store.signals()).toEqual({})
  })
  it('keeps display-only sensors out of automation and accepts multiple devices per metric', () => {
    const bedside = { ...source, id: 'left_temperature', deviceId: 'left_homepod', externalId: 'left.temp', unit: '°F' as const, useForControl: false }
    store.configure({ ...config, sources: [source, bedside] }, 1)
    store.receive(report({ revision: 2 }))
    store.receive(report({ revision: 2, sourceId: bedside.id, value: 95 }))
    expect(store.status().observations).toHaveLength(2)
    expect(store.status().aggregates[0]).toMatchObject({ value: 75.2, status: 'ready', sourceIds: [source.id] })
  })
})
