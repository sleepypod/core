// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { engineFixture } from '@/src/automation/tests/controllerHarness'
import type { AutomationRule } from '@/src/automation/types'
import { createRoomContextStore } from '../store'
import { ROOM_HISTORY_LIMIT, ROOM_RETENTION_MS, roomConfigSchema } from '../contract'
import { homeAssistantAutomations } from '../homeAssistant'

const start = 1793000000000
const config = roomConfigSchema.parse({ enabled: true, roomName: 'Bedroom', mappings: [{ metric: 'temperature', entityId: 'sensor.bedroom_temperature', unit: '°C', timestampAttribute: 'last_seen', timestampFormat: 'iso8601', maxAgeSeconds: 60 }] })
let directory: string, database: ReturnType<typeof migratedComfortDatabase>, store: ReturnType<typeof createRoomContextStore>, now: number
const flags = { retain: false, dup: false }
const report = (patch: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ schemaVersion: 1, source: 'home_assistant', revision: 1, metric: 'temperature', entityId: 'sensor.bedroom_temperature', unit: '°C', available: true, value: 20, measuredAt: now - 1000, reportedAt: now, ...patch }))
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'room-context-'))
  database = migratedComfortDatabase(join(directory, 'config.db'))
  now = start
  store = createRoomContextStore(database, () => now)
  store.configure(config, 0)
  store.connection(true, 'test/pod/room/report')
})
afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('qualified home measurements', () => {
  it('normalizes units, preserves original clocks and expires without making old values live', () => {
    expect(store.signals()).toEqual({})
    expect(store.receive(report(), flags)).toBe(true)
    expect(store.signals()).toEqual({ 'room.temperature': 68 })
    expect(store.status().observations[0]).toMatchObject({ value: 68, measuredAt: start - 1000, receivedAt: start, expiresAt: start + 59000, status: 'fresh' })
    now += 59000
    expect(store.status().observations[0]).toMatchObject({ value: null, lastValue: 68, status: 'stale' })
    expect(store.signals()).toEqual({})
    expect(store.history().items[0]).toMatchObject({ value: 68, unit: '°F', revision: 1 })
  })
  it('persists replay rejection across restart and reconnect without promoting history', () => {
    const original = report()
    store.receive(original, flags)
    store = createRoomContextStore(database, () => now)
    expect(store.status().observations[0].status).toBe('disconnected')
    store.connection(true)
    expect(store.status().observations[0].status).toBe('waiting')
    expect(store.receive(original, flags)).toBe(false)
    now += 6000
    expect(store.receive(report({ measuredAt: start - 1000 }), flags)).toBe(false)
    expect(store.receive(report(), flags)).toBe(true)
    store.connection(false)
    expect(store.signals()).toEqual({})
    store.connection(true)
    expect(store.signals()).toEqual({})
  })
  it('withdraws immediately on unavailability and keeps a watermark against resurrected old measurements', () => {
    store.receive(report(), flags)
    now += 1
    expect(store.receive(report({ available: false, value: null, measuredAt: null }), flags)).toBe(true)
    expect(store.status().observations[0]).toMatchObject({ value: null, status: 'unavailable' })
    now += 6000
    expect(store.receive(report({ measuredAt: start - 2000 }), flags)).toBe(false)
    expect(store.signals()).toEqual({})
    expect(store.receive(report(), flags)).toBe(true)
  })
  it('rejects malformed, retained, duplicate, stale, future, unmapped, wrong-unit and invalid-range input', () => {
    for (const payload of [Buffer.from('{'), Buffer.alloc(2049), Buffer.alloc(0)]) expect(store.receive(payload, flags)).toBe(false)
    for (const badFlags of [{ retain: true, dup: false }, { retain: false, dup: true }]) expect(store.receive(report(), badFlags)).toBe(false)
    for (const patch of [
      { schemaVersion: 2 }, { source: 'other' }, { revision: 2 }, { metric: 'humidity' }, { entityId: 'sensor.other' },
      { unit: '°F' }, { value: '20' }, { value: 1000 }, { value: null }, { measuredAt: null }, { available: false },
      { reportedAt: now + 1 }, { reportedAt: now - 30000, measuredAt: now - 31000 }, { measuredAt: now + 1 },
      { measuredAt: now - 60000 }, { secret: 'unexpected' }, { measuredAt: 0 },
    ]) expect(store.receive(report(patch), flags), JSON.stringify(patch)).toBe(false)
    expect(store.history().items).toEqual([])
  })
  it('bounds report rate, rejects clock rollback and does not refresh a duplicate measurement', () => {
    store.receive(report(), flags)
    now += 10
    expect(store.receive(report(), flags)).toBe(false)
    now = start - 10
    expect(store.signals()).toEqual({})
    expect(store.status().observations[0].status).toBe('clock_invalid')
    expect(store.receive(report(), flags)).toBe(false)
    now = NaN
    expect(store.signals()).toEqual({})
    expect(() => store.status()).toThrow()
  })
  it('requires owner configuration, supports conflict detection and invalidates old publishers on save', () => {
    store.receive(report(), flags)
    expect(() => store.configure(config, 0)).toThrow(/changed/)
    expect(store.configure({ ...config, enabled: false }, 1).revision).toBe(2)
    expect(store.signals()).toEqual({})
    expect(store.receive(report(), flags)).toBe(false)
    store.configure(config, 2)
    expect(store.receive(report(), flags)).toBe(false)
    expect(store.receive(report({ revision: 3 }), flags)).toBe(true)
    expect(store.history().items.map(item => item.revision)).toEqual([3, 1])
    expect(() => store.configure({ ...config, mappings: [...config.mappings, ...config.mappings] }, 3)).toThrow()
    expect(() => store.configure({ ...config, mappings: [{ ...config.mappings[0], unit: '%' }] }, 3)).toThrow()
  })
  it('bounds history by count and retention, and pages without overlap', () => {
    database.transaction(() => {
      const insert = database.prepare('INSERT INTO room_context_history (revision, metric, entity_id, unit, measured_at, reported_at, received_at, value, available) VALUES (1, ?, ?, ?, ?, ?, ?, 68, 1)')
      for (let index = 0; index < ROOM_HISTORY_LIMIT + 10; index++) insert.run('temperature', 'sensor.bedroom_temperature', '°F', now - 2000, now - 1000, now - 1000)
    })()
    store.receive(report(), flags)
    expect(database.prepare('SELECT COUNT(*) AS count FROM room_context_history').get()).toEqual({ count: ROOM_HISTORY_LIMIT })
    const first = store.history(), second = store.history(first.nextBeforeId ?? undefined)
    expect(first.items).toHaveLength(200)
    expect(second.items).toHaveLength(200)
    expect(first.items.at(-1)?.id).toBeGreaterThan(second.items[0].id)
    now += ROOM_RETENTION_MS + 1
    expect(store.history().items).toEqual([])
    store.receive(report(), flags)
    expect(store.history().items).toHaveLength(1)
  })
  it.each(['expiry', 'disconnect', 'unavailable', 'disabled'] as const)('withdraws an actual window policy on %s despite historical window samples', async (failure) => {
    store.receive(report({ value: 28 }), flags)
    const rule: AutomationRule = { id: 1, name: 'Synthetic room policy', enabled: true, dryRun: false, side: 'left', priority: 0,
      trigger: { kind: 'tick', everyMin: 1 }, conditions: { kind: 'compare', op: '>', left: { kind: 'window', fn: 'avg', signal: 'room.temperature', lastMin: 10 }, right: { kind: 'literal', value: 75 } },
      actions: [{ kind: 'setTemperature', mode: 'policy', temp: { kind: 'literal', value: 74 } }], cooldownMin: 0 }
    const { engine, control } = engineFixture({ signals: { read: () => store.signals() }, now: () => now,
      clock: () => ({ nowMinutes: 1, dayOfWeek: 'monday', dateKey: '2026-10-26' }),
      getHardware: () => ({ connect: async () => {}, setTemperature: async () => {}, setPower: async () => {} }),
      withSideLock: async (_side, action) => action(), pumpStallShouldBlock: () => false, broadcast: vi.fn(), markMutated: vi.fn(),
      loadRules: async () => [rule], recordRun: async () => {}, disableRule: async () => {}, hasActiveRunOnceSession: async () => false, notify: vi.fn() })
    await engine.reload()
    await engine.tick()
    expect(control.status('left').source).toBe('autopilot')
    now += failure === 'expiry' ? 60000 : 1000
    if (failure === 'disconnect') store.connection(false)
    if (failure === 'unavailable') store.receive(report({ available: false, value: null, measuredAt: null }), flags)
    if (failure === 'disabled') store.configure({ ...config, enabled: false }, 1)
    await engine.tick()
    expect(control.status('left').source).toBeNull()
  })
})

describe('Home Assistant publisher documents', () => {
  it.each(['iso8601', 'unix_seconds', 'unix_milliseconds'] as const)('keeps the %s source timestamp, configured units and revision', (format) => {
    const [automation] = homeAssistantAutomations({ revision: 2, config: { ...config, mappings: [{ ...config.mappings[0], timestampFormat: format }] } }, 'sleepypod/test/room/report')
    expect(automation.triggers).toContainEqual({ trigger: 'time_pattern', seconds: '/30' })
    const data = automation.actions[0].data
    expect(data).toMatchObject({ qos: 0, retain: false })
    expect(data.payload).toContain('state_attr(\'sensor.bedroom_temperature\', \'last_seen\')')
    expect(data.payload).toContain('\'revision\': 2')
    expect(data.payload.match(/now\(\)/g)).toHaveLength(1)
    expect(data.payload).toContain('\'measuredAt\': measurement if usable else none')
    expect(JSON.parse(JSON.stringify(automation))).toEqual(automation)
  })
  it('rejects wildcard or command-topic publishing and unsafe template identifiers', () => {
    expect(() => homeAssistantAutomations({ revision: 1, config }, 'sleepypod/+/room/report')).toThrow()
    expect(() => homeAssistantAutomations({ revision: 1, config }, 'sleepypod/test/cmd/request')).toThrow()
    expect(() => roomConfigSchema.parse({ ...config, mappings: [{ ...config.mappings[0], timestampAttribute: 'x\') }}' }] })).toThrow()
  })
})
