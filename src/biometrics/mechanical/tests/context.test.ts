// @vitest-environment node
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { mechanicalObservation } from '../context'
import { MechanicalStore } from '../store'
import { mechanicalStateSchema } from '../context'
import { readMechanicalSnapshot } from '../snapshot'
import { installMechanicalObserver, recordMechanicalCommand } from '../dispatch'
import { mechanicalWindowProof } from '../proof'

const databases: Database.Database[] = []
afterEach(() => {
  databases.splice(0).forEach(database => database.close())
})
function setup() {
  const database = new Database(':memory:')
  databases.push(database)
  database.exec(readFileSync(new URL('../../../db/biometrics-migrations/0032_mechanical_signal_context.sql', import.meta.url), 'utf8').replaceAll('--> statement-breakpoint', ''))
  const store = new MechanicalStore(database)
  const observe = (now: number, changes = {}) => store.observe({ now, deviceAt: now, baseAt: now,
    priming: false, vibrationCommandActive: false, baseMoving: false, ...changes })
  const quiet = (from = 100000, to = 120000) => {
    for (let now = from; now <= to; now += 1000) observe(now)
    return mechanicalStateSchema.parse(store.read())
  }
  return { database, store, observe, quiet }
}

it('extends quiet coverage with actual source timestamps, never cached polling time', () => {
  const { quiet, observe, database } = setup()
  const state = quiet()
  expect(state).toMatchObject({ cleanSinceMs: 110000, confirmedThroughMs: 120000, reasons: [] })
  const cached = observe(125000, { deviceAt: 120000, baseAt: 120000 })
  expect(cached.confirmedThroughMs).toBe(120000)
  expect(readMechanicalSnapshot(database, 125000)?.spans[0]).toMatchObject({ startMs: 110000, endMs: 120000 })
  expect(observe(130000, { deviceAt: 120000, baseAt: 120000 }).cleanSinceMs).toBeNull()
})

it.each([
  { priming: true }, { baseMoving: true }, { vibrationCommandActive: true },
  { priming: null }, { baseMoving: null }, { vibrationCommandActive: null },
  { deviceAt: null }, { baseAt: null }, { deviceAt: 140000 }, { baseAt: 110000 },
  { priming: undefined }, { baseMoving: undefined }, { vibrationCommandActive: undefined },
])('closes a span and requires a fresh settling window for %j', (changes) => {
  const { quiet, observe, database } = setup()
  const previous = quiet()
  expect(observe(121000, changes).cleanSinceMs).toBeNull()
  const recovered = quiet(122000, 132000)
  expect(recovered.cleanSinceMs).toBeGreaterThanOrEqual(131000)
  expect(recovered.spanId).not.toBe(previous.spanId)
  expect(readMechanicalSnapshot(database, 132000)?.spans).toHaveLength(2)
})

it('preserves a pre-dispatch vibration exclusion through Stop and process restart', () => {
  const { store, database, quiet } = setup()
  quiet()
  store.command('vibration', 121000, 180000)
  store.command('vibration', 122000, 0)
  const restarted = new MechanicalStore(database)
  for (let now = 123000; now <= 310000; now += 1000) {
    expect(restarted.observe({ now, deviceAt: now, baseAt: now, priming: false, vibrationCommandActive: false, baseMoving: false }).cleanSinceMs).toBeNull()
  }
  expect(restarted.observe({ now: 311000, deviceAt: 311000, baseAt: 311000, priming: false, vibrationCommandActive: false, baseMoving: false }).cleanSinceMs).toBe(311000)
})

it('does not join evidence over source clock reversal, observer gap or journal failure', () => {
  const { quiet, observe, store, database } = setup()
  quiet()
  expect(observe(121000, { deviceAt: 119000 }).cleanSinceMs).toBeNull()
  expect(readMechanicalSnapshot(database, 121000)?.spans).toEqual([])
  const next = quiet(122000, 132000)
  expect(observe(142000).spanId).toBeNull()
  expect(quiet(143000, 153000).spanId).not.toBe(next.spanId)
  store.invalidate(154000)
  expect(observe(155000).spanId).toBeNull()
  expect(readMechanicalSnapshot(database, 165000)).toBeNull()
})

it('stops future quiet evidence and rejects malformed clock/command inputs', () => {
  const { store, quiet } = setup()
  quiet()
  store.stop(121000)
  expect(store.read()).toMatchObject({ spanId: null, reasons: ['controller_stopped'] })
  expect(() => store.command('base', NaN)).toThrow()
  expect(() => store.command('vibration', 122000, 180001)).toThrow()
  expect(() => mechanicalObservation({ now: NaN } as never)).toThrow()
})

it('restores the shared database timeout after success and failed persistence', () => {
  const { database, quiet, store } = setup()
  database.pragma('busy_timeout = 1234')
  quiet()
  expect(database.pragma('busy_timeout', { simple: true })).toBe(1234)
  database.exec('CREATE TRIGGER reject_context BEFORE INSERT ON biometric_mechanical_state BEGIN SELECT RAISE(FAIL, \'storage unavailable\'); END')
  expect(() => store.command('priming', 121000)).toThrow('storage unavailable')
  expect(database.pragma('busy_timeout', { simple: true })).toBe(1234)
})

it('requires durable start records but keeps emergency cancellation available', () => {
  const command = vi.fn(() => {
    throw new Error('disk full')
  })
  const uninstall = installMechanicalObserver({ command })
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    expect(() => recordMechanicalCommand('base')).toThrow('disk full')
    expect(() => recordMechanicalCommand('vibration', 0, true)).not.toThrow()
    expect(command).toHaveBeenCalledTimes(2)
  }
  finally {
    uninstall()
    warning.mockRestore()
  }
})

it('requires one full measurement-window receipt, preserving firmware fractions', () => {
  const { quiet } = setup(), state = quiet()
  const row = { timestampMs: 500000, heartRate: 60, breathingRate: 12, hrv: null }
  const proof = `mechanical_context_v1:${state.epoch}:${state.spanId}:439375:501375`
  expect(mechanicalWindowProof([proof], row)).toMatchObject({ startMs: 439375, endMs: 501375 })
  expect(() => mechanicalWindowProof([], row)).toThrow()
  expect(() => mechanicalWindowProof([proof, proof], row)).toThrow()
  expect(() => mechanicalWindowProof([proof], { ...row, hrv: 30 })).toThrow()
})
