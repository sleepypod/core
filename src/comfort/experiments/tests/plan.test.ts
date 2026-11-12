import { describe, expect, it } from 'vitest'
import { experimentPlanSchema, experimentProposalSchema } from '../contract'
import { createExperimentPlan, experimentContextMatches, experimentNightAt, experimentNights, experimentPlanHash } from '../plan'
import { context, createdAt, fixturePlan } from './fixture'

describe('personal comfort assignment protocol', () => {
  it('balances every pair and both period orders, with a settling night before each scored night', () => {
    const plan = fixturePlan(), nights = experimentNights(plan)
    expect(nights).toHaveLength(16)
    expect(nights.filter(night => night.arm === 'baseline')).toHaveLength(8)
    expect(nights.filter(night => night.role === 'scored')).toHaveLength(8)
    for (let pair = 0; pair < 4; pair++) {
      const current = nights.filter(night => night.pair === pair)
      expect(current.map(night => night.role)).toEqual(['settling', 'scored', 'settling', 'scored'])
      expect(new Set(current.map(night => night.arm)).size).toBe(2)
      expect(current[0].arm).toBe(current[1].arm)
      expect(current[2].arm).toBe(current[3].arm)
    }
  })

  it('draws each of the six balanced orders with equal probability', () => {
    const frequencies = new Map<string, number>()
    for (let first = 0; first < 4; first++) for (let second = 0; second < 3; second++) for (let third = 0; third < 2; third++) {
      const draws = [first, second, third]
      const plan = createExperimentPlan(context, { firstNightDate: '2026-11-13', variantF: 69 }, createdAt, () => draws.shift() ?? -1)
      const key = plan.orders.join(',')
      frequencies.set(key, (frequencies.get(key) ?? 0) + 1)
    }
    expect(frequencies.size).toBe(6)
    expect([...frequencies.values()]).toEqual([4, 4, 4, 4, 4, 4])
  })

  it.each([NaN, -1, 4, 0.5])('rejects an invalid random provider (%s)', (draw) => {
    expect(() => createExperimentPlan(context, { firstNightDate: '2026-11-13', variantF: 69 }, createdAt, () => draw)).toThrow()
  })

  it.each([70, 67, 73, 69.5])('rejects identical, distant or fractional treatments (%s)', (variantF) => {
    expect(() => createExperimentPlan(context, { firstNightDate: '2026-11-13', variantF }, createdAt)).toThrow()
  })

  it('does not expand an overnight comfort envelope to accommodate a treatment', () => {
    expect(() => createExperimentPlan({ ...context, minimumF: 70 }, { firstNightDate: '2026-11-13', variantF: 69 }, createdAt)).toThrow()
  })

  it.each(['2026-02-30', '2026-11-11', '2026-12-13'])('rejects invalid, past or distant start dates (%s)', (firstNightDate) => {
    expect(() => createExperimentPlan(context, { firstNightDate, variantF: 69 }, createdAt)).toThrow()
  })

  it('never accepts client identity, wake configuration or random order as proposal fields', () => {
    for (const field of ['context', 'subjectKey', 'wakeHash', 'orders']) {
      expect(experimentProposalSchema.safeParse({ firstNightDate: '2026-11-13', variantF: 69, [field]: 'unexpected' }).success).toBe(false)
    }
  })

  it.each(['2026-03-06', '2026-10-30', '2028-02-25'])('keeps consecutive local dates across DST and leap day (%s)', (date) => {
    const plan = createExperimentPlan({ ...context, timezone: 'America/Los_Angeles' },
      { firstNightDate: date, variantF: 69 }, Date.parse(`${date}T12:00:00Z`))
    const dates = experimentNights(plan).map(night => night.date)
    expect(new Set(dates).size).toBe(16)
    expect(dates[15]).toBe(new Date(Date.parse(date) + 15 * 86_400_000).toISOString().slice(0, 10))
  })

  it('binds saved assignment order, timezone, range and wake plan into the review identity', () => {
    const plan = fixturePlan(), digest = experimentPlanHash(plan)
    expect(experimentPlanHash(JSON.parse(JSON.stringify(plan)))).toBe(digest)
    expect(experimentPlanHash({ ...plan, orders: [...plan.orders].reverse() })).not.toBe(digest)
    for (const field of ['bindingHash', 'routineHash', 'wakeHash', 'subjectKey'] as const) {
      expect(experimentContextMatches(plan, { ...context, [field]: 'f'.repeat(64) })).toBe(false)
    }
    expect(experimentContextMatches(plan, { ...context, minimumF: 69 })).toBe(false)
    expect(experimentContextMatches(plan, context)).toBe(true)
  })

  it('resolves the night from the routine start, not the following wake date', () => {
    const plan = fixturePlan()
    expect(experimentNightAt(plan, Date.parse('2026-11-13T22:00:00Z'))?.date).toBe('2026-11-13')
    expect(experimentNightAt(plan, createdAt - 1)).toBeNull()
    expect(experimentNightAt(plan, Date.parse('2026-12-13T22:00:00Z'))).toBeNull()
  })

  it('rejects tampered unbalanced saved assignments', () => {
    expect(experimentPlanSchema.safeParse({ ...fixturePlan(), orders: Array(4).fill('baseline_first') }).success).toBe(false)
  })
})
