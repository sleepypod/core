import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TRPCError } from '@trpc/server'
import { DEFAULT_STAGE_CLASSIFIER, MOVEMENT_ONLY_STAGE_RULESET, type StageClassifier } from '@/src/lib/sleep-stage-rules'
import { activeDemoNight, deleteDemoNight, demoNights } from '../history'
import { HOUR, startOfDay } from '../util'
import { sleepStages } from '../handlers/sleepStages'

function required<T>(handler: T | undefined): T {
  if (!handler) throw new Error('Missing demo handler')
  return handler
}

const NOW = Date.UTC(2026, 9, 10, 12)
const movementOnly: StageClassifier = { engine: 'rules', ruleset: MOVEMENT_ONLY_STAGE_RULESET }

describe('demo sleepStages', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })

  afterEach(async () => {
    await required(sleepStages.setClassifier)({ side: 'left', classifier: null })
    vi.useRealTimers()
  })

  it('keeps a classifier per side for the session', async () => {
    expect((await required(sleepStages.getClassifier)({ side: 'left' })).isDefault).toBe(true)
    await required(sleepStages.setClassifier)({ side: 'left', classifier: movementOnly })
    const left = await required(sleepStages.getClassifier)({ side: 'left' })
    expect(left).toMatchObject({ classifier: movementOnly, isDefault: false, defaults: DEFAULT_STAGE_CLASSIFIER })
    expect((await required(sleepStages.getClassifier)({ side: 'right' })).isDefault).toBe(true)
  })

  it('previews the latest night against the scripted hypnogram', async () => {
    const out = await required(sleepStages.previewClassifier)({ side: 'left', classifier: movementOnly })
    expect(out.sleepRecordId).toBe(demoNights('left')[0].id)
    expect(out.hasReference).toBe(true)
    expect(out.candidate?.distribution.deep).toBe(0)
    expect(out.candidate?.agreement?.epochs).toBeGreaterThan(0)
    expect(out.saved).not.toBeNull()
  })

  it('previews several nights and records changes with their effect', async () => {
    const week = await required(sleepStages.previewClassifier)({ side: 'left', nights: 7, classifier: movementOnly })
    expect(week.nights).toBeGreaterThan(1)
    expect(week.candidate?.stats.nights).toBe(week.nights)
    expect(week.changed).not.toBeNull()

    await required(sleepStages.setClassifier)({ side: 'left', classifier: movementOnly })
    // Earlier tests' saves and resets stay in the session log; the newest is first.
    const { changes } = await required(sleepStages.getClassifier)({ side: 'left' })
    expect(changes[0]).toMatchObject({ summary: 'Removed rule 2: Deep +4 more', before: null })
    expect(changes[0].agreementAfter).not.toBeNull()
  })

  it('rejects another side\'s night', async () => {
    const right = demoNights('right')[0]
    expect(() => required(sleepStages.previewClassifier)({ side: 'left', sleepRecordId: right.id, classifier: movementOnly }))
      .toThrow(/not found for side 'left'/)
  })

  it('rejects an unknown night', async () => {
    const unknown = demoNights('left')[0].id + 2 * 365 * 2
    try {
      await required(sleepStages.previewClassifier)({ side: 'left', sleepRecordId: unknown, classifier: movementOnly })
      throw new Error('expected NOT_FOUND')
    }
    catch (error) {
      expect(error).toBeInstanceOf(TRPCError)
      expect((error as TRPCError).code).toBe('NOT_FOUND')
      expect((error as TRPCError).message).toBe(`Sleep record ${unknown} not found for side 'left'`)
    }
  })

  it('previews one night by id, ignoring `nights`', async () => {
    const older = demoNights('left')[3]
    const out = await required(sleepStages.previewClassifier)({ side: 'left', sleepRecordId: older.id, nights: 7, classifier: movementOnly })
    expect(out.sleepRecordId).toBe(older.id)
    expect(out.nights).toBe(1)
    expect(out.enteredBedAt).toBe(older.enteredBedAt.getTime())
    expect(out.leftBedAt).toBe(older.leftBedAt?.getTime())
    expect(out.candidate?.stats.nights).toBe(1)
  })

  it('previews a night in progress with no leftBedAt', async () => {
    // 02:00 local: last night's session is still running.
    vi.setSystemTime(startOfDay(0, NOW).getTime() + 2 * HOUR)
    const active = activeDemoNight('left')
    expect(active).not.toBeNull()
    const out = await required(sleepStages.previewClassifier)({ side: 'left', classifier: movementOnly })
    expect(out.sleepRecordId).toBe(active?.id)
    expect(out.leftBedAt).toBeNull()
    expect(out.hasReference).toBe(true)
    expect(out.saved).not.toBeNull()
    expect(out.candidate?.stats.epochs).toBeGreaterThan(0)
  })

  it('returns null results when the night has no vitals yet', async () => {
    vi.setSystemTime(startOfDay(0, NOW).getTime() + 2 * HOUR)
    const [latest] = demoNights('left')
    // Right as the occupant gets into bed: no vitals sampled, nothing to classify.
    vi.setSystemTime(latest.enteredBedAt.getTime())
    const out = await required(sleepStages.previewClassifier)({ side: 'left', classifier: movementOnly })
    expect(out).toMatchObject({ sleepRecordId: latest.id, leftBedAt: null, nights: 1, saved: null, candidate: null, changed: null })

    // A save now has no agreement to record either way.
    await required(sleepStages.setClassifier)({ side: 'left', classifier: movementOnly })
    const { changes } = await required(sleepStages.getClassifier)({ side: 'left' })
    expect(changes[0]).toMatchObject({ summary: 'Removed rule 2: Deep +4 more', agreementBefore: null, agreementAfter: null })
  })

  it('records nothing for a reset with nothing stored, or for a repeated save', async () => {
    const before = (await required(sleepStages.getClassifier)({ side: 'left' })).changes.length
    expect(await required(sleepStages.setClassifier)({ side: 'left', classifier: null })).toEqual({ classifier: DEFAULT_STAGE_CLASSIFIER, isDefault: true })
    expect((await required(sleepStages.getClassifier)({ side: 'left' })).changes).toHaveLength(before)

    await required(sleepStages.setClassifier)({ side: 'left', classifier: movementOnly })
    await required(sleepStages.setClassifier)({ side: 'left', classifier: movementOnly })
    expect((await required(sleepStages.getClassifier)({ side: 'left' })).changes).toHaveLength(before + 1)

    expect(await required(sleepStages.setClassifier)({ side: 'left', classifier: null })).toEqual({ classifier: DEFAULT_STAGE_CLASSIFIER, isDefault: true })
    const { changes } = await required(sleepStages.getClassifier)({ side: 'left' })
    expect(changes).toHaveLength(before + 2)
    expect(changes[0]).toMatchObject({ summary: 'Reset to default', before: movementOnly })
    expect(changes[0].agreementBefore).not.toBeNull()
  })

  it('lists at most the ten most recent changes, newest first', async () => {
    for (let i = 0; i < 12; i++) {
      await required(sleepStages.setClassifier)({ side: 'right', classifier: i % 2 === 0 ? movementOnly : DEFAULT_STAGE_CLASSIFIER })
    }
    const { changes } = await required(sleepStages.getClassifier)({ side: 'right' })
    expect(changes).toHaveLength(10)
    expect(changes.map(c => c.id)).toEqual([...changes.map(c => c.id)].sort((a, b) => b - a))
    expect(changes[0]).toMatchObject({ summary: 'Added rule 2: Deep +4 more', before: movementOnly })
    expect(changes[1]).toMatchObject({ summary: 'Removed rule 2: Deep +4 more', before: DEFAULT_STAGE_CLASSIFIER })
    // The first two saves (one from nothing stored) fell off the end.
    expect(changes.every(c => c.before !== null)).toBe(true)
    await required(sleepStages.setClassifier)({ side: 'right', classifier: null })
  })

  // Deletes every demo night on the right side, so it runs last.
  it('handles a side with no nights', async () => {
    for (const n of demoNights('right')) deleteDemoNight(n.id)
    expect(demoNights('right')).toEqual([])

    const out = await required(sleepStages.previewClassifier)({ side: 'right', classifier: movementOnly })
    expect(out).toEqual({ sleepRecordId: null, enteredBedAt: null, leftBedAt: null, nights: 0, hasReference: false, saved: null, candidate: null, changed: null })

    await required(sleepStages.setClassifier)({ side: 'right', classifier: movementOnly })
    const { changes } = await required(sleepStages.getClassifier)({ side: 'right' })
    expect(changes[0]).toMatchObject({ summary: 'Removed rule 2: Deep +4 more', agreementBefore: null, agreementAfter: null })
  })
})
