import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { Side } from '@/src/hardware/types'
import { createComfortStore, comfortEvent } from '../store'
import { defaultComfortState, type ComfortContext } from '../policy'
import { capturePreviewEvidence, previewReportId, type PreviewOrigin } from '../report-evidence'
import { createPreviewReports } from '../reports'
import { migratedComfortDatabase } from './databaseFixture'

const databases: ReturnType<typeof migratedComfortDatabase>[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))
const MINUTE = 60_000
const DAY = 86_400_000
const now = Date.parse('2026-10-26T18:00:00Z')
function harness() {
  const database = migratedComfortDatabase()
  databases.push(database)
  const store = createComfortStore(database)
  let clock = now
  const reports = createPreviewReports(database, () => clock)
  function record(start: number, options: {
    side?: Side
    minutes?: number[]
    origin?: PreviewOrigin
    timezone?: string
    sourceKey?: string
    runId?: string
    alterContext?: (context: ComfortContext) => void } = {}) {
    const side = options.side ?? 'left'
    const runId = options.runId ?? randomUUID()
    const state = { ...defaultComfortState(), config: { mode: 'preview' as const, minimumF: 70, maximumF: 95 } }
    let id = ''
    for (const minute of options.minutes ?? Array.from({ length: 241 }, (_, index) => index)) {
      const at = start + minute * MINUTE
      const context: ComfortContext = { now: at,
        window: { start, end: start + 8 * 60 * MINUTE, session: `night:${start}`, segment: 'initial', baselineF: 75, alarmAt: null,
          phases: { revision: 'b'.repeat(64), startF: 75, changes: [] } },
        device: { observedAt: at, targetF: 75, powered: true, waterAdequate: true, priming: false, vibrating: false, baseMoving: false },
        presence: { observedAt: at, available: true, occupied: true,
          entry: { measuredAt: at, sourceKey: options.sourceKey ?? 'c'.repeat(64), state: 'present' } },
        eitherAway: false, routinesPaused: false, alarmOverride: false, targetKnown: true, owner: 'schedule' }
      options.alterContext?.(context)
      const evidence = capturePreviewEvidence(state, context, 75, options.timezone ?? 'America/Los_Angeles', runId,
        options.origin ?? { environment: 'production', buildRevision: 'a'.repeat(40) })
      if (!evidence) throw new Error('Synthetic report fixture needs evidence')
      id = previewReportId(evidence)
      store.commit(side, state, { ...comfortEvent(at, 'preview', 'Preview only.'), session: evidence.session,
        eligible: true, proposedF: 74, reportedF: 75, deviceObservedAt: at, presenceObservedAt: at, owner: 'schedule', preview: evidence })
    }
    return id
  }
  async function confirm(id: string, side: Side = 'left') {
    const report = await reports.detail(side, id)
    return reports.review({ side, id, digest: report.summary.digest, expectedReviewId: report.review?.id ?? null,
      outcome: 'reviewed', confirmedActualNight: true, note: 'Synthetic test confirmation, not an actual night.' })
  }
  return { database, store, reports, record, confirm, setClock: (value: number) => {
    clock = value
  } }
}

describe('Preview reports and owner review', () => {
  it('does not turn legacy history, check-ins or baseline dates into a Preview night', async () => {
    const { store, reports } = harness()
    store.commit('left', defaultComfortState(), { ...comfortEvent(now - DAY, 'preview', 'Legacy observation'), session: 'legacy' })
    expect(await reports.list('left')).toMatchObject({ items: [], ownerConfirmedNights: 0, targetNights: 7, activationAvailable: false })
  })

  it('summarizes and pages real journal rows, requiring explicit review before counting', async () => {
    const { record, reports, confirm, store } = harness()
    const id = record(now - DAY)
    const first = await reports.detail('left', id)
    expect(first.summary).toMatchObject({ observationCount: 241, occupiedObservationMs: 4 * 60 * MINUTE,
      reviewable: true, eligibleCount: 241, sensorReadyCount: 0, gapCount: 1 })
    expect(first.summary.gaps[0]).toEqual({ from: now - DAY + 4 * 60 * MINUTE, to: now - DAY + 8 * 60 * MINUTE })
    expect(first.observations).toHaveLength(200)
    expect(first.nextAfterId).not.toBeNull()
    const next = await reports.detail('left', id, first.nextAfterId ?? 0)
    expect(next.observations).toHaveLength(41)
    expect(next.nextAfterId).toBeNull()
    expect((await reports.list('left')).ownerConfirmedNights).toBe(0)
    const reviewed = await confirm(id)
    expect(await confirm(id)).toEqual(reviewed)
    expect((await reports.list('left')).ownerConfirmedNights).toBe(1)
    expect(store.read('left')).toMatchObject({ config: { mode: 'preview' }, lastAppliedAt: 0, lastTargetF: null })
    expect((await reports.list('right')).items).toEqual([])
    await expect(reports.detail('right', id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('cannot count two distant samples, sparse checks, or test/development origins as an overnight observation', async () => {
    for (const options of [
      { minutes: [0, 240] }, { minutes: Array.from({ length: 241 }, (_, index) => index * 1.5) },
      { origin: { environment: 'test' as const, buildRevision: 'a'.repeat(40) } },
      { origin: { environment: 'development' as const, buildRevision: 'a'.repeat(40) } },
      { origin: { environment: 'production' as const, buildRevision: null } },
    ]) {
      const { record, reports, confirm } = harness()
      // Two-minute gaps exceed the allowed pairing interval; 90 seconds is the inclusive boundary.
      if ('minutes' in options && options.minutes?.length === 241) options.minutes = options.minutes.map(value => value * 1.1)
      const id = record(now - DAY, options)
      const report = await reports.detail('left', id)
      expect(report.summary.reviewable).toBe(false)
      await expect(confirm(id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
      expect((await reports.list('left')).ownerConfirmedNights).toBe(0)
      await reports.review({ side: 'left', id, digest: report.summary.digest, expectedReviewId: null, outcome: 'needs_retest', confirmedActualNight: false, note: 'Incomplete' })
    }
  })

  it('does not bridge runtime restarts or calibration changes when computing observation intervals', async () => {
    const { record, reports } = harness()
    const start = now - DAY
    const id = record(start, { minutes: [0] })
    record(start, { minutes: [1], sourceKey: 'd'.repeat(64) })
    expect((await reports.detail('left', id)).summary.occupiedObservationMs).toBe(0)
  })

  it.each(['stale device', 'vibration', 'unknown base', 'stale frame', 'ambiguous level', 'empty'] as const)(
    'excludes %s observations from the occupied interval requirement', async (condition) => {
      const { record, reports, confirm } = harness()
      const id = record(now - DAY, { alterContext: (context) => {
        if (condition === 'stale device') context.device.observedAt = context.now - 60_000
        if (condition === 'vibration') context.device.vibrating = true
        if (condition === 'unknown base') context.device.baseMoving = null
        if (condition === 'empty') context.presence.occupied = false
        if (context.presence.entry) {
          if (condition === 'stale frame') context.presence.entry.measuredAt = context.now - 60_000
          if (condition === 'ambiguous level') context.presence.entry.state = 'unknown'
        }
      } })
      expect((await reports.detail('left', id)).summary).toMatchObject({ occupiedObservationMs: 0, reviewable: false })
      await expect(confirm(id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    },
  )

  it('rejects a review when its journal changes while the report yields to other work', async () => {
    const { record, reports, database } = harness()
    const id = record(now - DAY, { minutes: Array.from({ length: 300 }, (_, index) => index) })
    const initial = await reports.detail('left', id)
    const pending = reports.review({ side: 'left', id, digest: initial.summary.digest, expectedReviewId: null,
      outcome: 'reviewed', confirmedActualNight: true, note: '' })
    // Parsing yields after 256 rows. Mutate the already-read source before its transaction.
    database.prepare('DELETE FROM comfort_events WHERE id = (SELECT MIN(id) FROM comfort_events WHERE report_id = ?)').run(id)
    await expect(pending).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(database.prepare('SELECT COUNT(*) AS count FROM comfort_reviews').get()).toEqual({ count: 0 })
  })

  it('keeps a prior review as history after retention expires without counting it as current evidence', async () => {
    const { record, reports, confirm, setClock, database } = harness()
    const id = record(now - DAY)
    await confirm(id)
    setClock(now + 31 * DAY)
    expect(await reports.detail('left', id)).toMatchObject({ summary: { reviewable: false }, countsAsOwnerConfirmedNight: false })
    database.prepare('DELETE FROM comfort_events WHERE report_id = ?').run(id)
    expect(await reports.detail('left', id)).toMatchObject({ summary: { state: 'source_expired' }, review: { outcome: 'reviewed' } })
    setClock(now + 181 * DAY)
    expect((await reports.list('left')).items).toEqual([])
  })

  it('detects a reversed observation clock even when every timestamp is in the past', async () => {
    const { record, reports, confirm } = harness()
    const id = record(now - DAY, { minutes: [0, 2, 1, ...Array.from({ length: 241 }, (_, index) => index + 3)] })
    expect((await reports.detail('left', id)).summary.issues).toContain('The observation clock repeated or moved backward; inspect before counting this night.')
    await expect(confirm(id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('keeps collecting sessions and future or reversed clocks out of night counts', async () => {
    const { record, reports, confirm, setClock } = harness()
    const id = record(now - 5 * 60 * MINUTE)
    expect((await reports.detail('left', id)).summary.state).toBe('collecting')
    await expect(confirm(id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    setClock(now - DAY)
    await expect(reports.detail('left', id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('rejects changed report digests and stale review conclusions, then invalidates reviews when source changes', async () => {
    const { record, reports, database, confirm } = harness()
    const id = record(now - DAY)
    const initial = await reports.detail('left', id)
    await expect(reports.review({ side: 'left', id, digest: 'f'.repeat(64), expectedReviewId: null,
      outcome: 'reviewed', confirmedActualNight: true, note: '' })).rejects.toMatchObject({ code: 'CONFLICT' })
    const saved = await confirm(id)
    await expect(reports.review({ side: 'left', id, digest: initial.summary.digest, expectedReviewId: null,
      outcome: 'needs_retest', confirmedActualNight: false, note: '' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await reports.review({ side: 'left', id, digest: initial.summary.digest, expectedReviewId: saved.id,
      outcome: 'needs_retest', confirmedActualNight: false, note: 'Review superseded.' })
    expect((await reports.list('left')).ownerConfirmedNights).toBe(0)
    await confirm(id)
    database.prepare('DELETE FROM comfort_events WHERE id = (SELECT MIN(id) FROM comfort_events WHERE report_id = ?)').run(id)
    expect(await reports.detail('left', id)).toMatchObject({ reviewCurrent: false, countsAsOwnerConfirmedNight: false })
    database.prepare('DELETE FROM comfort_events WHERE report_id = ?').run(id)
    expect(await reports.detail('left', id)).toMatchObject({ summary: { state: 'source_expired', reviewable: false }, reviewCurrent: false })
  })

  it('requires explicit owner confirmation, counts distinct nights, and never unlocks Active at seven', async () => {
    const { record, reports, confirm } = harness()
    for (let day = 1; day <= 7; day++) await confirm(record(now - day * DAY))
    const list = await reports.list('left')
    expect(list).toMatchObject({ ownerConfirmedNights: 7, activationAvailable: false })
    const id = list.items[0].summary.id
    await expect(reports.review({ side: 'left', id, digest: list.items[0].summary.digest, expectedReviewId: list.items[0].review?.id ?? null,
      outcome: 'reviewed', confirmedActualNight: false, note: '' })).rejects.toThrow('Confirm')
    // Same observation window expressed in a different timezone remains one night.
    await confirm(record(now - DAY, { timezone: 'Asia/Tokyo' }))
    expect((await reports.list('left')).ownerConfirmedNights).toBe(7)
  })

  it('fails closed on malformed evidence and atomically leaves reviews unchanged on write failure', async () => {
    const { record, reports, database, confirm } = harness()
    const id = record(now - DAY)
    database.exec('CREATE TRIGGER fail_review BEFORE INSERT ON comfort_reviews BEGIN SELECT RAISE(ABORT, \'test\'); END')
    await expect(confirm(id)).rejects.toThrow('test')
    expect((await reports.detail('left', id)).review).toBeNull()
    database.exec('DROP TRIGGER fail_review')
    database.prepare('UPDATE comfort_events SET event = ? WHERE id = (SELECT MIN(id) FROM comfort_events WHERE report_id = ?)').run('{bad', id)
    await expect(reports.list('left')).rejects.toThrow()
  })
})
