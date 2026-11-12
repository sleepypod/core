import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { migratedComfortDatabase } from '../../tests/databaseFixture'
import { ComfortExperimentReviews } from '../reviews'
import { EXPERIMENT_REVIEW_MS } from '../contract'
import { context, createdAt, fixturePlan } from './fixture'

let database: Database.Database, reviews: ComfortExperimentReviews, directory: string, now: number
const scope = '1'.repeat(64)
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sleepypod-experiment-review-'))
  database = migratedComfortDatabase(join(directory, 'review.db'))
  now = createdAt
  reviews = new ComfortExperimentReviews(database, context.subjectKey, () => now)
})
afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true })
})

it('reads the exact review through another database connection and after reopening it', () => {
  const plan = fixturePlan()
  now += 2
  reviews.create(plan, scope)
  const other = new Database(join(directory, 'review.db'))
  try {
    expect(new ComfortExperimentReviews(other, context.subjectKey, () => now).read(plan.id, scope)).toEqual(plan)
  }
  finally { other.close() }
  database.close()
  database = new Database(join(directory, 'review.db'))
  reviews = new ComfortExperimentReviews(database, context.subjectKey, () => now)
  expect(reviews.read(plan.id, scope)).toEqual(plan)
})

it('rejects another subject/session, future clocks and exact expiry', () => {
  const plan = fixturePlan()
  reviews.create(plan, scope)
  expect(new ComfortExperimentReviews(database, 'f'.repeat(64), () => now).read(plan.id, scope)).toBeNull()
  expect(reviews.read(plan.id, '2'.repeat(64))).toBeNull()
  now = createdAt - 1
  expect(reviews.read(plan.id, scope)).toBeNull()
  now = createdAt + EXPERIMENT_REVIEW_MS - 1
  expect(reviews.read(plan.id, scope)).toEqual(plan)
  now++
  expect(reviews.read(plan.id, scope)).toBeNull()
})

it('limits reviews per person and prunes expired metadata before accepting another', () => {
  for (let index = 0; index < 8; index++) reviews.create(fixturePlan(), scope)
  expect(() => reviews.create(fixturePlan(), scope)).toThrow('already open')
  const otherSubject = 'f'.repeat(64), other = new ComfortExperimentReviews(database, otherSubject, () => now)
  const plan = fixturePlan()
  expect(() => other.create({ ...plan, context: { ...plan.context, subjectKey: otherSubject } }, scope)).not.toThrow()
  now = createdAt + EXPERIMENT_REVIEW_MS
  reviews.create({ ...fixturePlan(), createdAt: now }, scope)
  expect(database.prepare('SELECT COUNT(*) AS count FROM comfort_experiment_reviews').get()).toEqual({ count: 1 })
})

it.each(['scope', 'expiry', 'identity'] as const)('does not trust corrupted %s metadata', (kind) => {
  const plan = fixturePlan()
  reviews.create(plan, scope)
  if (kind === 'scope') {
    database.exec('UPDATE comfort_experiment_reviews SET scope_hash = \'changed\'')
    expect(reviews.read(plan.id, scope)).toBeNull()
  }
  else {
    if (kind === 'expiry') database.exec('UPDATE comfort_experiment_reviews SET expires_at = expires_at + 1')
    else database.prepare('UPDATE comfort_experiment_reviews SET plan = ?').run(JSON.stringify({ ...plan, context: { ...plan.context, subjectKey: 'f'.repeat(64) } }))
    expect(() => reviews.read(plan.id, scope)).toThrow('inconsistent')
  }
})
