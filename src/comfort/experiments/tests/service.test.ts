import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { migratedComfortDatabase } from '../../tests/databaseFixture'
import { ComfortExperimentService } from '../service'
import { ComfortExperimentStore } from '../store'
import { EXPERIMENT_REVIEW_MS } from '../contract'
import { type ExperimentAccess } from '../access'
import { context, createdAt, fixturePlan, fixtureSchedule } from './fixture'

let database: Database.Database, service: ComfortExperimentService, now: number, current: typeof context, unreadable: boolean
let schedule: ReturnType<typeof fixtureSchedule>
const access: ExperimentAccess = { subjectKey: context.subjectKey, scope: { account: 'first', session: 1 },
  binding: { assignment: 1 }, routineSide: 'left', ready: true }
const proposal = { firstNightDate: '2026-11-13', variantF: 69 }
const confirmation = (review: ReturnType<ComfortExperimentService['prepare']>) => ({ reviewId: review.reviewId, planHash: review.planHash })
const createService = () => new ComfortExperimentService(database, () => now, () => {
  if (unreadable) throw new Error('fixture settings failure')
  return { context: current, reason: 'fixture policy', schedule }
})
beforeEach(() => {
  database = migratedComfortDatabase()
  now = createdAt
  current = { ...context }
  unreadable = false
  schedule = fixtureSchedule()
  service = createService()
})
afterEach(() => database.close())

it('reviews one immutable balanced plan, confirms it once and reconciles after restart without resurrecting Stop', () => {
  const review = service.prepare(access, proposal), request = confirmation(review)
  expect(review.nights).toHaveLength(16)
  expect(review.execution).toBe('planning_only')
  expect(service.overview(access).experiments).toEqual([])
  now += 120_000
  const first = service.confirm(access, request)
  expect(first.record.plan).toEqual(review.plan)
  service = createService()
  now += 24 * 3_600_000
  expect(service.confirm(access, request).record).toEqual(first.record)
  const stopped = service.stop(access, review.reviewId, { expectedRevision: first.record.revision })
  expect(service.confirm(access, request).record).toEqual(stopped.record)
  expect(service.stop(access, review.reviewId, { expectedRevision: first.record.revision }).record).toEqual(stopped.record)
})

it.each(['wakeHash', 'routineHash', 'bindingHash', 'subjectKey'] as const)('rejects a changed %s before creating the reviewed plan', (field) => {
  const review = service.prepare(access, proposal)
  current[field] = 'f'.repeat(64)
  expect(() => service.confirm(access, confirmation(review))).toThrow('changed')
  expect(new ComfortExperimentStore(database, access.subjectKey, () => now).list()).toEqual([])
})

it('rejects scope changes, forged plans and stale previews across restart', () => {
  const review = service.prepare(access, proposal)
  expect(() => service.confirm({ ...access, scope: { account: 'first', session: 2 } }, confirmation(review))).toThrow('account')
  expect(() => service.confirm(access, { ...confirmation(review), plan: review.plan })).toThrow()
  expect(() => service.confirm(access, { ...confirmation(review), planHash: 'f'.repeat(64) })).toThrow('preview')
  now += EXPERIMENT_REVIEW_MS
  expect(() => service.confirm(access, confirmation(review))).toThrow('expired')
  service = createService()
  expect(() => service.confirm(access, confirmation(review))).toThrow('expired')
})

it('confirms the original unexpired review through another worker without drawing a new order', () => {
  const review = service.prepare(access, proposal)
  now += 60_000
  const otherWorker = createService()
  expect(otherWorker.confirm(access, confirmation(review)).record.plan).toEqual(review.plan)
})

it('never accepts client-selected identity, policy, telemetry or timestamps', () => {
  for (const fields of [{ subjectKey: 'f'.repeat(64) }, { side: 'right' }, { baselineF: 65 }, { minimumF: 50 }, { wakeHash: 'f'.repeat(64) }])
    expect(() => service.prepare(access, { ...proposal, ...fields })).toThrow()
  const review = service.prepare(access, proposal), record = service.confirm(access, confirmation(review)).record
  const feedback = { nightDate: '2026-11-13', confirmedFullNight: true, comfort: 7, unwantedAdjustments: 0, problem: false }
  now = Date.parse('2026-11-14T10:00:00Z')
  for (const fields of [{ recordedAt: now }, { observedMs: 28_000_000 }, { execution: 'active' }])
    expect(() => service.saveFeedback(access, record.plan.id, { expectedRevision: record.revision, feedback: { ...feedback, ...fields } })).toThrow()
  const saved = service.saveFeedback(access, record.plan.id, { expectedRevision: record.revision, feedback })
  expect(saved.record.feedback[0].recordedAt).toBe(now)
  expect(saved.comparison.recommendation).toBe('inconclusive')
  expect(saved.record.exposures).toEqual([])
  expect(() => service.stop(access, record.plan.id, { expectedRevision: record.revision })).toThrow('changed')
})

it('keeps cancellation and historical reading usable when policy is corrupt, without hiding gaps', () => {
  const review = service.prepare(access, proposal), record = service.confirm(access, confirmation(review)).record
  unreadable = true
  expect(service.detail(access, record.plan.id)).toMatchObject({ contextCurrent: false, record: { status: 'planned' } })
  expect(service.stop(access, record.plan.id, { expectedRevision: record.revision }).record.status).toBe('stopped')
  expect(() => service.prepare(access, proposal)).toThrow('could not be read')
})

it('isolates reads, confirmation retries and feedback by authenticated subject', () => {
  const review = service.prepare(access, proposal), record = service.confirm(access, confirmation(review)).record
  const other = { ...access, subjectKey: 'f'.repeat(64), scope: { account: 'second' } }
  expect(service.overview(other).experiments).toEqual([])
  expect(() => service.detail(other, record.plan.id)).toThrow('not in your library')
  expect(() => service.confirm(other, confirmation(review))).toThrow('expired')
  expect(() => service.stop(other, record.plan.id, { expectedRevision: record.revision })).toThrow('not in your library')
})

it('retains one open plan when two reviews are confirmed and rejects changed reuse of its ID', () => {
  const first = service.prepare(access, proposal), second = service.prepare(access, proposal)
  service.confirm(access, confirmation(first))
  expect(() => service.confirm(access, confirmation(second))).toThrow('Another experiment')
  expect(() => service.confirm(access, { reviewId: first.reviewId, planHash: second.planHash })).toThrow('different')
})

it('paginates more than fifty tied-clock records without duplication or cross-person cursors', () => {
  for (let index = 0; index < 55; index++) {
    const review = service.prepare(access, proposal), record = service.confirm(access, confirmation(review)).record
    service.stop(access, record.plan.id, { expectedRevision: record.revision })
  }
  const ids: string[] = []
  let cursor: string | undefined
  do {
    const page = service.overview(access, cursor)
    ids.push(...page.experiments.map(item => item.id))
    cursor = page.nextId ?? undefined
  } while (cursor)
  expect(ids).toHaveLength(55)
  expect(new Set(ids).size).toBe(55)
  expect(() => service.overview({ ...access, subjectKey: 'f'.repeat(64) }, ids[0])).toThrow('unavailable')
  expect(() => service.overview(access, randomUUID())).toThrow('unavailable')
})

it('does not expose raw schedule sources in the overview and never accepts client-picked windows', () => {
  expect(service.overview(access).availability).not.toHaveProperty('schedule')
  expect(() => service.prepare(access, { ...proposal, schedule: { windows: [] } })).toThrow()
  const review = service.prepare(access, proposal)
  expect(review.plan.version).toBe(2)
  expect(review.schedule.windows).toHaveLength(16)
  expect(review.schedule.windows[0].wake).toMatchObject({ temperatureF: 105, vibrationSeconds: 20 })
})

it('rejects confirmation once the first routine begins even inside the five-minute review deadline', () => {
  now = Date.parse('2026-11-13T21:58:00Z')
  const review = service.prepare(access, proposal)
  now += 3 * 60_000
  expect(() => service.confirm(access, confirmation(review))).toThrow('no longer available')
  expect(service.overview(access).experiments).toEqual([])
})

it('recomputes all windows on confirmation instead of trusting a still-matching mocked context hash', () => {
  const review = service.prepare(access, proposal)
  const friday = schedule.powers.find(row => row.dayOfWeek === 'friday')
  if (!friday) throw new Error('Expected Friday fixture')
  friday.onTime = '21:00'
  expect(() => service.confirm(access, confirmation(review))).toThrow('windows changed')
  expect(service.overview(access).experiments).toEqual([])
})

it('keeps legacy plans readable and stoppable without converting their unreviewed calendar dates', () => {
  const record = new ComfortExperimentStore(database, access.subjectKey, () => now).create(fixturePlan())
  expect(service.detail(access, record.plan.id).record.plan.version).toBe(1)
  expect(service.stop(access, record.plan.id, { expectedRevision: record.revision }).record.status).toBe('stopped')
})

it('accepts feedback only after the exact scheduled window ends and within fourteen days', () => {
  const review = service.prepare(access, proposal), record = service.confirm(access, confirmation(review)).record
  const report = { expectedRevision: record.revision, feedback: { nightDate: '2026-11-13', confirmedFullNight: true,
    comfort: 7, unwantedAdjustments: 0, problem: false } }
  now = review.schedule.windows[0].windowEnd - 1
  expect(() => service.saveFeedback(access, record.plan.id, report)).toThrow('completed night')
  now++
  const saved = service.saveFeedback(access, record.plan.id, report).record
  expect(saved.feedback[0].recordedAt).toBe(now)
  now += 14 * 86_400_000 + 1
  expect(() => service.saveFeedback(access, record.plan.id, { ...report, expectedRevision: saved.revision })).toThrow('fourteen mornings')
})
