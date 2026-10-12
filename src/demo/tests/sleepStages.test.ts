import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_STAGE_CLASSIFIER, MOVEMENT_ONLY_STAGE_RULESET, type StageClassifier } from '@/src/lib/sleep-stage-rules'
import { demoNights } from '../history'
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
})
