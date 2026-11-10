import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { createComfortLimitStore, ComfortLimitConflict } from '../limitStore'
import { comfortLimitConfigSchema, defaultComfortLimit, resolveComfortLimit } from '../limits'
import type { TemperatureRequest } from '../controller'
import { resetControlDatabase } from './databaseFixture'

const request: TemperatureRequest = { id: 'scheduled', source: 'schedule', temperature: 85,
  startsAt: 0, expiresAt: 2000, createdAt: 0, priority: 0 }
const version = { revision: 1, config: { enabled: true, minF: 68, maxF: 72 } }
describe('automatic comfort limits', () => {
  it.each(['schedule', 'run-once', 'autopilot'] as const)('bounds %s while preserving the original requested target', (source) => {
    expect(resolveComfortLimit({ ...request, source }, 85, version, false)).toMatchObject({ requestedF: 85, targetF: 72, state: 'limited' })
    expect(resolveComfortLimit({ ...request, source }, 55, version, false).targetF).toBe(68)
    expect(resolveComfortLimit({ ...request, source }, 70, version, false).state).toBe('within_range')
  })
  it('exempts only trusted scheduled wake requests and explicit manual holds', () => {
    expect(resolveComfortLimit(request, 105, version, true)).toMatchObject({ targetF: 105, state: 'wake', wakeUntil: 2000 })
    expect(resolveComfortLimit({ ...request, source: 'autopilot' }, 105, version, true).targetF).toBe(72)
    expect(resolveComfortLimit({ ...request, source: 'manual' }, 80, null, false).targetF).toBe(80)
  })
  it('withholds automatic writes for unreadable limits; defaults remain inert', () => {
    expect(resolveComfortLimit(request, 85, null, false).targetF).toBeNull()
    expect(resolveComfortLimit(request, 85, { revision: 0, config: defaultComfortLimit }, false).targetF).toBe(85)
  })
  it.each([{ minF: 73, maxF: 68 }, { minF: 55, maxF: 80 }, { minF: 54, maxF: 60 }, { minF: 70.5, maxF: 72 }])('rejects invalid range %o', (range) => {
    expect(comfortLimitConfigSchema.safeParse({ enabled: true, ...range }).success).toBe(false)
  })
  it('persists by side, rejects lost updates, and does not replace corrupt records with defaults', () => {
    const database = new Database(':memory:')
    try {
      resetControlDatabase(database)
      const store = createComfortLimitStore(database)
      expect(store.read('left')).toEqual({ revision: 0, config: defaultComfortLimit })
      expect(store.save('left', 0, version.config)).toEqual(version)
      expect(createComfortLimitStore(database).read('left')).toEqual(version)
      expect(store.read('right').revision).toBe(0)
      expect(() => store.save('left', 0, defaultComfortLimit)).toThrow(ComfortLimitConflict)
      database.prepare('UPDATE temperature_limits SET config = ? WHERE side = ?').run('{broken', 'left')
      expect(() => store.read('left')).toThrow()
      expect(() => store.save('left', 1, defaultComfortLimit)).toThrow()
    }
    finally { database.close() }
  })
})
