import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { thermalDataset, thermalDatasetAudit } from '../thermal-dataset'
import { migratedComfortDatabase } from './databaseFixture'
import { createComfortStore, comfortEvent } from '../store'
import { defaultComfortState } from '../policy'
import { createPreviewReports } from '../reports'

const databases: ReturnType<typeof migratedComfortDatabase>[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))
const start = Date.parse('2026-10-20T22:00:00Z'), end = start + 8 * 3600000, now = end + 86400000

async function fixture(options: { environment?: 'test' | 'production', eligible?: boolean, research?: boolean, variableTarget?: boolean, side?: 'left' | 'right', sampleAt?: (index: number) => number, sampleCount?: number, reviewed?: boolean, sleepWindowEnd?: number } = {}) {
  const database = migratedComfortDatabase()
  databases.push(database)
  const store = createComfortStore(database)
  const state = defaultComfortState(), side = options.side ?? 'left'
  const runId = randomUUID()
  for (let index = 0; index < (options.sampleCount ?? 480); index++) {
    const at = options.sampleAt?.(index) ?? start + index * 60000
    store.commit(side, state, { ...comfortEvent(at, 'preview', 'Synthetic fixture'),
      eligible: options.eligible ?? true, session: 'night',
      thermalContext: { targetF: options.variableTarget ? 70 + index % 5 : 70, waterF: 70, roomF: 75, humidity: 50 },
      ...(options.research ? { thermalObservation: { version: 1 as const, purpose: 'comfort_research' as const, bedroomConfiguration: 'e'.repeat(64), sleepWindowEnd: options.sleepWindowEnd ?? end } } : {}),
      preview: { format: 1, runId, environment: options.environment ?? 'production', buildRevision: 'a'.repeat(40),
        hardwareIdentity: 'b'.repeat(64), session: 'night', start, end, timezone: 'UTC', scheduleRevision: 'c'.repeat(64),
        policy: { minimumF: 69, maximumF: 71, sensorAware: true, followBedtime: false, offsetF: 0 },
        ...(options.research ? { bedroom: { state: 'ready' as const, offsetF: 0 as const, reason: 'Fixture', sourceIds: ['temperature', 'humidity'], expiresAt: at + 60000, configuration: 'e'.repeat(64) } } : {}),
        scheduledBaselineF: 70, decisionBaselineF: 70, presence: 'occupied', presenceSourceKey: 'd'.repeat(64),
        mechanicallyQuiet: true, deviceFresh: true, sensorReady: true, manualPaused: false },
    })
  }
  store.saveFeedback('left', { date: '2026-10-21', comfort: 'warm' }, comfortEvent(now, 'feedback', 'Fixture'))
  const confirm = async () => {
    const reports = createPreviewReports(database, () => now)
    const item = (await reports.list(side)).items[0]
    if (item?.summary.reviewable) await reports.review({ side, id: item.summary.id, digest: item.summary.digest,
      expectedReviewId: item.review?.id ?? null, outcome: 'reviewed', confirmedActualNight: true, note: 'Synthetic full-night fixture' })
  }
  if (options.reviewed !== false) await confirm()
  return { database, store, confirm }
}
describe('thermal learning observation provenance', () => {
  it('joins one actual night with a morning check-in, preserving side and thermal context', async () => {
    const { database } = await fixture()
    expect(thermalDataset(database, 'left', now)).toEqual([{ date: '2026-10-21', correction: -1, targetF: 70, waterF: 70, roomF: 75, humidity: 50 }])
    expect(thermalDataset(database, 'right', now)).toEqual([])
  })
  it('rejects test origins, withheld proposals, unmatched sides and ambiguous temperature curves', async () => {
    for (const options of [{ environment: 'test' as const }, { eligible: false }, { variableTarget: true }, { side: 'right' as const }]) {
      expect(thermalDataset((await fixture(options)).database, 'left', now)).toEqual([])
    }
  })
  it('does not train on an unfinished night or substitute check-ins alone for sensor data', async () => {
    const { database, store } = await fixture()
    expect(thermalDataset(database, 'left', end - 1)).toEqual([])
    const report = store.learning?.('left', null, 'UTC', now)
    expect(report).toMatchObject({ nights: 1, suggestedOffsetF: null })
    database.prepare('DELETE FROM comfort_events').run()
    expect(thermalDataset(database, 'left', now)).toEqual([])
  })
  it('learns from separately qualified thermal observations while heart-rate proposals remain withheld', async () => {
    const { database } = await fixture({ eligible: false, research: true })
    expect(thermalDataset(database, 'left', now)).toHaveLength(1)
    const rows = database.prepare('SELECT event FROM comfort_events WHERE json_extract(event,\'$.kind\')=\'preview\'').all() as { event: string }[]
    expect(rows.every(row => JSON.parse(row.event).eligible === false)).toBe(true)
  })
  it('rejects four-hour fragments even with a real owner review', async () => {
    const { database } = await fixture({ sampleCount: 250 })
    const result = thermalDatasetAudit(database, 'left', now)
    expect(result.nights).toEqual([])
    expect(result.collection.excluded[0].reason).toContain('six hours')
  })
  it('rejects missing edges, isolated late samples, and a long interior gap', async () => {
    for (const sampleAt of [
      (index: number) => start + 40 * 60000 + index * 60000,
      (index: number) => start + index * 60000 + (index > 230 ? 40 * 60000 : 0),
      (index: number) => start + index * 30000 + (index === 479 ? 4 * 3600000 : 0),
    ]) {
      const { database } = await fixture({ sampleAt, reviewed: false })
      expect(thermalDataset(database, 'left', now)).toEqual([])
    }
  })
  it('requires a current owner review and rejects edits after that review', async () => {
    const { database, confirm } = await fixture({ reviewed: false })
    expect(thermalDatasetAudit(database, 'left', now).collection.excluded[0].reason).toContain('Review this night')
    await confirm()
    expect(thermalDataset(database, 'left', now)).toHaveLength(1)
    database.prepare('UPDATE comfort_events SET event=json_set(event,\'$.message\',\'Corrected source\') WHERE observed_at = ?').run(start)
    expect(thermalDataset(database, 'left', now)).toEqual([])
    await confirm()
    expect(thermalDataset(database, 'left', now)).toHaveLength(1)
    database.prepare('UPDATE comfort_reviews SET created_at = ?').run(now + 1)
    expect(thermalDataset(database, 'left', now)).toEqual([])
  })
  it('uses the captured pre-alarm window and never admits wake warming', async () => {
    const { database } = await fixture({ research: true, eligible: false, sampleCount: 450, sleepWindowEnd: end - 30 * 60000 })
    expect(thermalDataset(database, 'left', now)).toHaveLength(1)
    database.prepare('UPDATE comfort_events SET event=json_set(event,\'$.thermalObservation.sleepWindowEnd\',?)').run(start + 5 * 3600000)
    expect(thermalDataset(database, 'left', now)).toEqual([])
  })
  it('rejects sparse observations and source changes even when they have enough sample rows', async () => {
    for (const modification of [
      'DELETE FROM comfort_events WHERE observed_at > ' + (start + 60 * 60000) + ' AND json_extract(event,\'$.kind\')=\'preview\'',
      'UPDATE comfort_events SET event=json_set(event,\'$.at\',json_extract(event,\'$.at\')+900000) WHERE observed_at=' + (start + 48 * 300000),
      'UPDATE comfort_events SET event=json_set(event,\'$.preview.presenceSourceKey\',\'' + 'f'.repeat(64) + '\') WHERE observed_at=' + start,
      'UPDATE comfort_events SET event=json_set(event,\'$.thermalObservation.bedroomConfiguration\',\'' + 'f'.repeat(64) + '\') WHERE observed_at=' + start,
    ]) {
      const { database } = await fixture({ eligible: false, research: true })
      database.exec(modification)
      expect(thermalDataset(database, 'left', now)).toEqual([])
    }
  })
})
