/**
 * compareToWatch against real in-memory sleepypod.db and biometrics.db with
 * migrations applied: night selection, pairing across the record's edges,
 * stage re-classification with the side's classifier, pooling and the
 * window bounds.
 */

import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { generateOpenApiDocument } from 'trpc-to-openapi'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as mainSchema from '@/src/db/schema'
import * as bioSchema from '@/src/db/biometrics-schema'
import { HRV_NOTE } from '@/src/biometrics/references/watch-deviation'
import { MOVEMENT_ONLY_STAGE_RULESET } from '@/src/lib/sleep-stage-rules'

const dbHolder = vi.hoisted(() => ({ main: null as unknown, bio: null as unknown }))

vi.mock('@/src/db', () => ({
  get db() { return dbHolder.main },
  get biometricsDb() { return dbHolder.bio },
}))
vi.mock('@/src/server/routers/raw', () => ({ listRawFiles: vi.fn(async () => []) }))
vi.mock('@/src/lib/occupancy', () => ({ getOccupancy: vi.fn() }))

const { biometricsRouter } = await import('@/src/server/routers/biometrics')
const caller = biometricsRouter.createCaller({})

const MIN = 60_000
const HOUR = 60 * MIN
// 2026-10-10 23:00:00 UTC
const BED = new Date(Date.UTC(2026, 9, 10, 23))
const at = (minutes: number, base = BED) => new Date(base.getTime() + minutes * MIN)
const WINDOW = { startDate: at(-60), endDate: at(3 * 24 * 60) }

describe('biometrics.compareToWatch', () => {
  let mainRaw: Database.Database
  let bioRaw: Database.Database
  let bio: ReturnType<typeof drizzle<typeof bioSchema>>

  beforeEach(() => {
    mainRaw = new Database(':memory:')
    const main = drizzle(mainRaw, { schema: mainSchema })
    migrate(main, { migrationsFolder: path.resolve(process.cwd(), 'src/db/migrations') })
    main.insert(mainSchema.sideSettings).values([{ side: 'left', name: 'Left' }, { side: 'right', name: 'Right' }]).run()
    dbHolder.main = main

    bioRaw = new Database(':memory:')
    bio = drizzle(bioRaw, { schema: bioSchema })
    migrate(bio, { migrationsFolder: path.resolve(process.cwd(), 'src/db/biometrics-migrations') })
    dbHolder.bio = bio
  })

  afterEach(() => {
    mainRaw.close()
    bioRaw.close()
  })

  /** A sleep record with pod vitals and movement every 5 minutes; HR 60, breathing 15, HRV 50. */
  function seedNight(base: Date, hours: number, side: 'left' | 'right' = 'left') {
    const [record] = bio.insert(bioSchema.sleepRecords).values({
      side, enteredBedAt: base, leftBedAt: at(hours * 60, base), sleepDurationSeconds: hours * 3600,
      timesExitedBed: 0, presentIntervals: [], notPresentIntervals: [],
    }).returning().all()
    const slots = Array.from({ length: hours * 12 }, (_, i) => at(i * 5, base))
    bio.insert(bioSchema.vitals).values(slots.map(timestamp => ({ side, timestamp, heartRate: 60, hrv: 50, breathingRate: 15 }))).run()
    bio.insert(bioSchema.movement).values(slots.map(timestamp => ({ side, timestamp, totalMovement: 10 }))).run()
    return record
  }

  function seedWatchHr(side: 'left' | 'right', samples: Array<[Date, number]>) {
    bio.insert(bioSchema.referenceVitals).values(samples.map(([timestamp, heartRate]) => ({ side, source: 'apple_watch' as const, timestamp, heartRate }))).run()
  }

  function seedWatchSamples(metric: 'breathing_rate' | 'hrv_sdnn', samples: Array<[Date, number]>) {
    bio.insert(bioSchema.referenceSamples).values(samples.map(([timestamp, value]) => ({ side: 'left' as const, source: 'apple_watch' as const, metric, timestamp, value }))).run()
  }

  it('reports deviation per night with pod − Watch pairing and the default classifier\'s stages', async () => {
    const record = seedNight(BED, 4)
    // 30 s after a pod reading pairs (HR 60 vs 58); 2 min 30 s from the nearest reading does not.
    seedWatchHr('left', [[at(0.5), 58], [at(10.5), 64], [at(17.5), 70]])
    seedWatchSamples('breathing_rate', [[at(2), 13], [at(60), 14]])
    seedWatchSamples('hrv_sdnn', [[at(120), 40]])
    bio.insert(bioSchema.referenceStages).values({ side: 'left', source: 'apple_watch', start: BED, end: at(4 * 60), stage: 'light' }).run()

    const out = await caller.compareToWatch({ side: 'left', ...WINDOW })
    expect(out).toMatchObject({ side: 'left', minHours: 3, hrvNote: HRV_NOTE, classifier: { isDefault: true, source: 'default', generation: null } })
    expect(out.nights).toHaveLength(1)
    const [night] = out.nights
    expect(night).toMatchObject({ sleepRecordId: record.id, hours: 4, enteredBedAt: BED })
    // HR pairs: (60, 58) and (60, 64); 17.5 min is 2.5 min from the nearest pod reading.
    expect(night.heartRate).toEqual({ n: 2, watchSamples: 3, coverage: 0.667, mae: 3, bias: -1, p90: 4, r: null })
    expect(night.breathingRate).toEqual({ n: 2, watchSamples: 2, coverage: 1, mae: 1.5, bias: 1.5, p90: 2, r: null })
    expect(night.hrv).toEqual({ n: 1, watchSamples: 1, coverage: 1, mae: 10, bias: 10, p90: 10, r: null })
    expect(night.stages).toMatchObject({ epochs: 48, recall: { light: expect.any(Number), wake: null, deep: null, rem: null } })
    expect(night.stages?.watchMinutes).toEqual({ wake: 0, light: 240, deep: 0, rem: 0 })
    const pod = night.stages?.podMinutes ?? { wake: 0, light: 0, deep: 0, rem: 0 }
    expect(pod.wake + pod.light + pod.deep + pod.rem).toBe(240)
    expect(out.summary).toMatchObject({ nights: 1, heartRate: night.heartRate, stages: night.stages })
  })

  it('pairs a Watch sample at bed entry with a pod reading just before it, but only scores Watch samples inside the record', async () => {
    seedNight(BED, 3)
    bioRaw.prepare('DELETE FROM vitals WHERE timestamp = ?').run(BED.getTime() / 1000)
    bio.insert(bioSchema.vitals).values({ side: 'left', timestamp: at(-20 / 60), heartRate: 70, hrv: 50, breathingRate: 15 }).run()
    seedWatchHr('left', [[at(-0.25), 99], [at(0), 69]])
    const out = await caller.compareToWatch({ side: 'left', ...WINDOW })
    // The bed-entry sample pairs with the pod reading 20 s before the record (the next one is 5 min later);
    // the sample 15 s before bed entry is outside the record and not scored.
    expect(out.nights[0].heartRate).toMatchObject({ n: 1, watchSamples: 1, mae: 1, bias: 1 })
  })

  it('keeps only this side\'s records of at least minHours entered in the window, oldest first, and pools the summary', async () => {
    const first = seedNight(BED, 3)
    const second = seedNight(at(24 * 60), 4)
    seedNight(at(48 * 60), 1)
    seedNight(at(30 * 24 * 60), 5)
    seedNight(BED, 5, 'right')
    seedWatchHr('left', [[at(5), 70]])
    seedWatchHr('left', [[at(5, second.enteredBedAt), 62], [at(10, second.enteredBedAt), 62], [at(15, second.enteredBedAt), 62]])
    seedWatchHr('right', [[at(5), 99]])

    const out = await caller.compareToWatch({ side: 'left', ...WINDOW })
    expect(out.nights.map(n => n.sleepRecordId)).toEqual([first.id, second.id])
    expect(out.nights.map(n => n.heartRate.mae)).toEqual([10, 2])
    // Pooled over the 4 pairs: (10 + 2 + 2 + 2) / 4, not the mean of 10 and 2.
    expect(out.summary).toMatchObject({ nights: 2, heartRate: { n: 4, watchSamples: 4, mae: 4, bias: -4 } })

    const short = await caller.compareToWatch({ side: 'left', ...WINDOW, minHours: 1 })
    expect(short.nights).toHaveLength(3)
    expect(short.nights[2]).toMatchObject({ hours: 1, heartRate: { watchSamples: 0, mae: null }, stages: null })
  })

  it('re-runs the side\'s effective classifier and reports which one', async () => {
    seedNight(BED, 3)
    mainRaw.prepare('UPDATE side_settings SET stage_classifier = ? WHERE side = ?')
      .run(JSON.stringify({ engine: 'rules', ruleset: MOVEMENT_ONLY_STAGE_RULESET }), 'left')
    bio.insert(bioSchema.referenceStages).values({ side: 'left', source: 'apple_watch', start: BED, end: at(3 * 60), stage: 'light' }).run()
    const out = await caller.compareToWatch({ side: 'left', ...WINDOW })
    expect(out.classifier).toMatchObject({ isDefault: false, source: 'legacy' })
    expect(out.nights[0].stages).toMatchObject({ epochs: 36, accuracy: 1, podMinutes: { light: 180 } })
  })

  it('lists profile generations acknowledged in the window at their latest numeric boundary, oldest first', async () => {
    const receipt = (side: 'left' | 'right', component: string, generation: number, atMin: number | null, state: 'applied' | 'pending_boundary' = 'applied') => ({
      side, component, generation, appliedHash: `h${generation}`, effectiveSampleTimeMs: atMin === null ? null : at(atMin).getTime(), state, heartbeatAtMs: at(0).getTime(),
    })
    bio.insert(bioSchema.biometricRuntimeReceipts).values([
      // Generation 3 takes effect once its last numeric component does; the stage consumer's receipt does not move it.
      receipt('left', 'heart_rate', 3, 30 * 60),
      receipt('left', 'breathing_rate', 3, 30 * 60 + 2),
      receipt('left', 'hrv_index', 3, 30 * 60 + 1),
      receipt('left', 'sleep_stages', 3, 40 * 60),
      receipt('left', 'heart_rate', 2, 10 * 60),
      receipt('left', 'heart_rate', 4, null, 'pending_boundary'),
      receipt('left', 'heart_rate', 1, -2 * 60),
      receipt('right', 'heart_rate', 5, 20 * 60),
    ]).run()
    const out = await caller.compareToWatch({ side: 'left', ...WINDOW })
    expect(out.configChanges).toEqual([
      { generation: 2, atMs: at(10 * 60).getTime() },
      { generation: 3, atMs: at(30 * 60 + 2).getTime() },
    ])
  })

  it('returns an empty report without nights and defaults to the last 14 days', async () => {
    seedNight(at(-20 * 24 * 60, new Date()), 4)
    const out = await caller.compareToWatch({ side: 'left' })
    expect(out.nights).toEqual([])
    expect(out.summary).toMatchObject({ nights: 0, heartRate: { n: 0, coverage: null, mae: null }, stages: null })
    expect(out.configChanges).toEqual([])
    expect(out.endDate.getTime() - out.startDate.getTime()).toBe(14 * 24 * HOUR)
  })

  it('rejects a reversed window, a window over 31 days and a negative minHours', async () => {
    await expect(caller.compareToWatch({ side: 'left', startDate: at(60), endDate: BED })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(caller.compareToWatch({ side: 'left', startDate: BED, endDate: at(32 * 24 * 60) }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Select at most 31 days' })
    await expect(caller.compareToWatch({ side: 'left', endDate: BED, startDate: at(-31 * 24 * 60) })).resolves.toMatchObject({ nights: [] })
    await expect(caller.compareToWatch({ side: 'left', minHours: -1 })).rejects.toThrow()
  })

  it('wraps database failures as INTERNAL_SERVER_ERROR', async () => {
    bioRaw.exec('DROP TABLE reference_samples')
    seedNight(BED, 3)
    await expect(caller.compareToWatch({ side: 'left', ...WINDOW }))
      .rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: expect.stringContaining('Failed to compare with the Watch') })
  })

  it('publishes a GET REST contract', () => {
    const document = generateOpenApiDocument(biometricsRouter, { title: 'Biometrics', version: '1.0.0', baseUrl: 'http://localhost/api' })
    expect(document.paths?.['/biometrics/watch-deviation']?.get).toBeDefined()
  })
})
