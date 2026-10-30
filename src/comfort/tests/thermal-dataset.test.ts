import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { thermalDataset } from '../thermal-dataset'
import { migratedComfortDatabase } from './databaseFixture'
import { createComfortStore, comfortEvent } from '../store'
import { defaultComfortState } from '../policy'

const databases: ReturnType<typeof migratedComfortDatabase>[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))
const start = Date.parse('2026-10-20T22:00:00Z'), end = start + 8 * 3600000, now = end + 86400000

function fixture(options: { environment?: 'test' | 'production', eligible?: boolean, variableTarget?: boolean, side?: 'left' | 'right' } = {}) {
  const database = migratedComfortDatabase()
  databases.push(database)
  const store = createComfortStore(database)
  const state = defaultComfortState(), side = options.side ?? 'left'
  for (let index = 0; index < 12; index++) {
    const at = start + index * 300000
    store.commit(side, state, { ...comfortEvent(at, 'preview', 'Synthetic fixture'),
      eligible: options.eligible ?? true,
      thermalContext: { targetF: options.variableTarget ? 70 + index : 70, waterF: 70, roomF: 75, humidity: 50 },
      preview: { format: 1, runId: randomUUID(), environment: options.environment ?? 'production', buildRevision: 'a'.repeat(40),
        hardwareIdentity: 'b'.repeat(64), session: 'night', start, end, timezone: 'UTC', scheduleRevision: 'c'.repeat(64),
        policy: { minimumF: 69, maximumF: 71, sensorAware: true, followBedtime: false, offsetF: 0 },
        scheduledBaselineF: 70, decisionBaselineF: 70, presence: 'occupied', presenceSourceKey: 'd'.repeat(64),
        mechanicallyQuiet: true, deviceFresh: true, sensorReady: true, manualPaused: false },
    })
  }
  store.saveFeedback('left', { date: '2026-10-21', comfort: 'warm' }, comfortEvent(now, 'feedback', 'Fixture'))
  return { database, store }
}
describe('thermal learning observation provenance', () => {
  it('joins one actual night with a morning check-in, preserving side and thermal context', () => {
    const { database } = fixture()
    expect(thermalDataset(database, 'left', now)).toEqual([{ date: '2026-10-21', correction: -1, targetF: 70, waterF: 70, roomF: 75, humidity: 50 }])
    expect(thermalDataset(database, 'right', now)).toEqual([])
  })
  it('rejects test origins, withheld proposals, unmatched sides and ambiguous temperature curves', () => {
    for (const options of [{ environment: 'test' as const }, { eligible: false }, { variableTarget: true }, { side: 'right' as const }]) {
      expect(thermalDataset(fixture(options).database, 'left', now)).toEqual([])
    }
  })
  it('does not train on an unfinished night or substitute check-ins alone for sensor data', () => {
    const { database, store } = fixture()
    expect(thermalDataset(database, 'left', end - 1)).toEqual([])
    const report = store.learning?.('left', null, 'UTC', now)
    expect(report).toMatchObject({ nights: 1, suggestedOffsetF: null })
    database.prepare('DELETE FROM comfort_events').run()
    expect(thermalDataset(database, 'left', now)).toEqual([])
  })
})
