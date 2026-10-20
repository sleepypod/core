import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_STAGE_RULESET } from '../sleep-stage-rules'
import {
  classifyWithStageModel,
  evaluateStageModel,
  failingTestVectors,
  filterModelOutliers,
  POD_NATIVE_CONTRACT,
  stageModelBlocks,
  stageModelContract,
  stageModelFeatures,
  stageModelSchema,
  type StageModel,
} from '../personal-stage-model'

/** A one-tree forest: deep when hrZ <= -0.5, wake when motionZ > 1, else light. */
function forest(overrides: Partial<StageModel> = {}): StageModel {
  return stageModelSchema.parse({
    version: 'test-forest',
    kind: 'forest',
    classes: ['wake', 'light', 'deep', 'rem'],
    featureContract: ['hrZ', 'hrStdZ', 'motionZ', 'nightFraction'],
    trees: [{
      // node 0: hrZ <= -0.5 → 1 (deep leaf) else 2; node 2: motionZ <= 1 → 3 (light) else 4 (wake)
      f: [0, -1, 2, -1, -1],
      t: [-0.5, 0, 1, 0, 0],
      l: [1, -1, 3, -1, -1],
      r: [2, -1, 4, -1, -1],
      v: [[0, 0, 0, 0], [0, 1, 9, 0], [0, 0, 0, 0], [1, 8, 1, 0], [7, 2, 1, 0]],
    }],
    testVectors: [
      { inputs: { hrZ: -1, hrStdZ: 0, motionZ: 0, nightFraction: 0.5 }, expected: 2 },
      { inputs: { hrZ: 0, hrStdZ: 0, motionZ: 2, nightFraction: 0.5 }, expected: 0 },
      { inputs: { hrZ: 0, hrStdZ: 0, motionZ: 0, nightFraction: 0.5 }, expected: 1 },
    ],
    ...overrides,
  })
}

describe('personal stage model evaluation', () => {
  it('walks a forest and averages leaf votes', () => {
    const model = forest()
    const deep = evaluateStageModel(model, { hrZ: -1, hrStdZ: 0, motionZ: 0, nightFraction: 0.5 })
    expect(deep.stage).toBe('deep')
    expect(deep.probabilities).toEqual([0, 0.1, 0.9, 0])
    expect(evaluateStageModel(model, { hrZ: 0, hrStdZ: 0, motionZ: 2, nightFraction: 0.5 }).stage).toBe('wake')
    expect(failingTestVectors(model)).toEqual([])
    expect(stageModelContract(model)).toBe('challenger')
  })

  it('refuses a model that fails its own vectors, and malformed trees', () => {
    const wrong = forest({ testVectors: [{ inputs: { hrZ: -1, hrStdZ: 0, motionZ: 0, nightFraction: 0.5 }, expected: 1 }] })
    expect(failingTestVectors(wrong)).toEqual([0])
    expect(stageModelSchema.safeParse({ ...forest(), trees: [{ f: [0], t: [0], l: [5], r: [0], v: [[1, 0, 0, 0]] }] }).success).toBe(false)
    expect(stageModelSchema.safeParse({ ...forest(), featureContract: ['hrZ'] }).success).toBe(false)
    expect(stageModelSchema.safeParse({ ...forest(), kind: 'logistic' }).success).toBe(false)
  })

  it('evaluates a multinomial logistic model through its scaler', () => {
    const model = stageModelSchema.parse({
      version: 'test-logistic',
      kind: 'logistic',
      classes: ['wake', 'light', 'deep', 'rem'],
      featureContract: ['hrZ', 'hrStdZ', 'motionZ', 'nightFraction'],
      logistic: {
        mean: [0, 0, 0, 0.5],
        scale: [1, 1, 1, 0.25],
        // wake likes motion, light is the default, deep likes low HR, rem likes late night.
        coef: [[0, 0, 2, 0], [0, 0, 0, 0], [-2, 0, 0, 0], [0, 0, 0, 2]],
        intercept: [0, 0.5, 0, 0],
        classIndices: [0, 1, 2, 3],
      },
      testVectors: [{ inputs: { hrZ: -2, hrStdZ: 0, motionZ: 0, nightFraction: 0.5 }, expected: 2 }],
    })
    expect(evaluateStageModel(model, { hrZ: -2, hrStdZ: 0, motionZ: 0, nightFraction: 0.5 }).stage).toBe('deep')
    expect(evaluateStageModel(model, { hrZ: 0, hrStdZ: 0, motionZ: 3, nightFraction: 0.5 }).stage).toBe('wake')
    expect(evaluateStageModel(model, { hrZ: 0, hrStdZ: 0, motionZ: 0, nightFraction: 1 }).stage).toBe('rem')
    const light = evaluateStageModel(model, { hrZ: 0, hrStdZ: 0, motionZ: 0, nightFraction: 0.5 })
    expect(light.stage).toBe('light')
    expect(light.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12)
    expect(failingTestVectors(model)).toEqual([])
  })

  it('evaluates a two-class logistic model with one coefficient row', () => {
    const model = stageModelSchema.parse({
      version: 'two-class',
      kind: 'logistic',
      classes: ['wake', 'light', 'deep', 'rem'],
      featureContract: ['hrZ', 'hrStdZ', 'motionZ', 'nightFraction'],
      logistic: { mean: [0, 0, 0, 0], scale: [1, 1, 1, 1], coef: [[-3, 0, 0, 0]], intercept: [0], classIndices: [1, 2] },
      testVectors: [{ inputs: { hrZ: -1, hrStdZ: 0, motionZ: 0, nightFraction: 0 }, expected: 2 }],
    })
    expect(evaluateStageModel(model, { hrZ: -1, hrStdZ: 0, motionZ: 0, nightFraction: 0 }).stage).toBe('deep')
    expect(evaluateStageModel(model, { hrZ: 1, hrStdZ: 0, motionZ: 0, nightFraction: 0 }).stage).toBe('light')
  })
})

describe('feature contract parity', () => {
  interface Fixture {
    enteredBed: number
    leftBed: number
    vitals: { ts: number, hr: number | null, hrv: number | null, br: number | null }[]
    movement: { ts: number, total: number }[]
    contractA: Record<string, number>[]
    contractB: Record<string, number>[]
  }

  it('reproduces the Python port on the synthetic night, both contracts', () => {
    const fixture = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'stage-features-night.json'), 'utf8')) as Fixture
    const vitals = fixture.vitals.map(v => ({ timestamp: new Date(v.ts * 1000), heartRate: v.hr, hrv: v.hrv, breathingRate: v.br }))
    const movement = fixture.movement.map(m => ({ timestamp: new Date(m.ts * 1000), totalMovement: m.total }))
    const entered = new Date(fixture.enteredBed * 1000)
    const left = new Date(fixture.leftBed * 1000)
    for (const [contract, expected] of [['challenger', fixture.contractA], ['podNative', fixture.contractB]] as const) {
      const rows = stageModelFeatures(contract, entered, left, vitals, movement)
      expect(rows.length).toBe(expected.length)
      rows.forEach((row, i) => {
        expect(row.start).toBe(expected[i].start)
        for (const column of contract === 'challenger' ? Object.keys(row.values) : POD_NATIVE_CONTRACT) {
          expect(Math.abs(row.values[column] - expected[i][column])).toBeLessThan(1e-6)
        }
      })
    }
  })

  it('drops a partial trailing epoch and epochs without heart rate', () => {
    const t0 = new Date(Date.UTC(2026, 9, 1))
    const vitals = [0, 1, 6, 7].map(m => ({ timestamp: new Date(t0.getTime() + m * 60_000), heartRate: 60 + m, hrv: 40, breathingRate: 14 }))
    const rows = stageModelFeatures('challenger', t0, new Date(t0.getTime() + 16 * 60_000), vitals, [])
    // Three whole epochs; the middle one (5–10 min) has samples at 6 and 7, the last (10–15) has none.
    expect(rows.map(r => (r.start - t0.getTime() / 1000) / 60)).toEqual([0, 5])
  })
})

describe('classifyWithStageModel', () => {
  it('stages a night in 5-minute epochs and smooths an isolated epoch', () => {
    const t0 = new Date(Date.UTC(2026, 9, 1, 23))
    // 30 minutes, one vital a minute. Heart rate dips hard in minutes 10–14 only, so the forest calls that
    // epoch deep between two light ones and smoothing takes it back to light.
    const vitals = Array.from({ length: 30 }, (_, m) => ({
      timestamp: new Date(t0.getTime() + m * 60_000),
      heartRate: m >= 10 && m < 15 ? 48 : 60 + (m % 2),
      hrv: 40,
      breathingRate: 14,
    }))
    const epochs = classifyWithStageModel(forest(), t0, new Date(t0.getTime() + 30 * 60_000), vitals, [])
    expect(epochs.length).toBe(6)
    expect(epochs.every(e => e.duration === 300_000)).toBe(true)
    expect(epochs.map(e => e.stage)).toEqual(['light', 'light', 'light', 'light', 'light', 'light'])
    expect(epochs[2].heartRate).toBe(48)
    expect(stageModelBlocks(epochs)).toEqual([{ start: t0.getTime(), end: t0.getTime() + 30 * 60_000, stage: 'light' }])
  })
})

describe('schema edge cases', () => {
  const base = () => JSON.parse(JSON.stringify(forest())) as Record<string, unknown>
  const tree = () => ({ f: [0, -1, -1], t: [0, 0, 0], l: [1, -1, -1], r: [2, -1, -1], v: [[0, 0, 0, 0], [0, 1, 0, 0], [1, 0, 0, 0]] })

  it('rejects trees whose arrays disagree, have no nodes, point backwards, or vote with the wrong width', () => {
    expect(stageModelSchema.safeParse({ ...base(), trees: [{ ...tree(), t: [0] }] }).success).toBe(false)
    expect(stageModelSchema.safeParse({ ...base(), trees: [{ f: [], t: [], l: [], r: [], v: [] }] }).success).toBe(false)
    expect(stageModelSchema.safeParse({ ...base(), trees: [{ ...tree(), l: [0, -1, -1] }] }).success).toBe(false)
    expect(stageModelSchema.safeParse({ ...base(), trees: [{ ...tree(), v: [[0, 0, 0], [0, 1, 0], [1, 0, 0]] }] }).success).toBe(false)
    expect(stageModelSchema.safeParse({ ...base(), trees: [] }).success).toBe(false)
    expect(stageModelSchema.safeParse({ ...base(), trees: undefined }).success).toBe(false)
  })

  it('rejects logistic weights that do not match the contract or the classes, and vectors missing a column', () => {
    const logistic = (overrides: Record<string, unknown>) => ({
      ...base(), kind: 'logistic', trees: undefined,
      logistic: { mean: [0, 0, 0, 0], scale: [1, 1, 1, 1], coef: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], intercept: [0, 0, 0, 0], classIndices: [0, 1, 2, 3], ...overrides },
      testVectors: [{ inputs: { hrZ: 0, hrStdZ: 0, motionZ: 0, nightFraction: 0 }, expected: 0 }],
    })
    expect(stageModelSchema.safeParse(logistic({})).success).toBe(true)
    expect(stageModelSchema.safeParse(logistic({ mean: [0, 0] })).success).toBe(false)
    expect(stageModelSchema.safeParse(logistic({ coef: [[0, 0, 0, 0]] })).success).toBe(false)
    expect(stageModelSchema.safeParse(logistic({ intercept: [0] })).success).toBe(false)
    expect(stageModelSchema.safeParse({ ...logistic({}), logistic: undefined }).success).toBe(false)
    expect(stageModelSchema.safeParse({ ...base(), testVectors: [{ inputs: { hrZ: 0 }, expected: 0 }] }).success).toBe(false)
  })

  it('reports missing features, empty leaves and an unknown contract', () => {
    expect(() => evaluateStageModel(forest(), { hrZ: 0, hrStdZ: 0, motionZ: 0 })).toThrow(/nightFraction/)
    expect(() => evaluateStageModel(forest(), { hrZ: Number.NaN, hrStdZ: 0, motionZ: 0, nightFraction: 0 })).toThrow()
    // A leaf with no votes counts a quarter for every class.
    const hollow = forest({ trees: [{ f: [-1], t: [0], l: [-1], r: [-1], v: [[0, 0, 0, 0]] }], testVectors: [{ inputs: { hrZ: 0, hrStdZ: 0, motionZ: 0, nightFraction: 0 }, expected: 0 }] })
    expect(evaluateStageModel(hollow, { hrZ: 0, hrStdZ: 0, motionZ: 0, nightFraction: 0 }).probabilities).toEqual([0.25, 0.25, 0.25, 0.25])
    const unknown = forest({ featureContract: ['hrZ', 'hrStdZ', 'motionZ', 'nightFraction', 'extra'],
      testVectors: [{ inputs: { hrZ: -1, hrStdZ: 0, motionZ: 0, nightFraction: 0, extra: 0 }, expected: 2 }] })
    expect(stageModelContract(unknown)).toBeNull()
    expect(() => classifyWithStageModel(unknown, new Date(0), new Date(3_600_000), [], [])).toThrow(/contract/)
    // A vector the model cannot evaluate counts as failing (built past the schema, which would refuse it).
    const unevaluable = { ...forest(), testVectors: [{ inputs: { hrZ: 0 }, expected: 1 }] } as StageModel
    expect(failingTestVectors(unevaluable)).toEqual([0])
  })

  it('zeroes a scaled feature whose scale is zero and ignores rows outside the bed window', () => {
    const model = stageModelSchema.parse({
      version: 'zero-scale', kind: 'logistic', classes: ['wake', 'light', 'deep', 'rem'],
      featureContract: ['hrZ', 'hrStdZ', 'motionZ', 'nightFraction'],
      logistic: { mean: [0, 0, 0, 0], scale: [0, 1, 1, 1], coef: [[5, 0, 0, 0]], intercept: [0], classIndices: [1, 2] },
      testVectors: [{ inputs: { hrZ: 9, hrStdZ: 0, motionZ: 0, nightFraction: 0 }, expected: 1 }],
    })
    expect(evaluateStageModel(model, { hrZ: 9, hrStdZ: 0, motionZ: 0, nightFraction: 0 }).stage).toBe('light')
    const t0 = new Date(Date.UTC(2026, 9, 2))
    const vitals = [-5, 0, 1, 2, 3, 4, 20].map(m => ({ timestamp: new Date(t0.getTime() + m * 60_000), heartRate: 60, hrv: null, breathingRate: Number.NaN }))
    const rows = stageModelFeatures('podNative', t0, new Date(t0.getTime() + 10 * 60_000), vitals, [{ timestamp: new Date(t0.getTime() - 60_000), totalMovement: 500 }])
    expect(rows).toHaveLength(1)
    expect(rows[0].values.hrvRel).toBe(0)
    expect(rows[0].values.br15Std).toBe(0)
    expect(rows[0].values.motion15).toBe(0)
    expect(stageModelFeatures('challenger', t0, new Date(t0.getTime() + 60_000), vitals, [])).toEqual([])
  })

  it('leaves spikes alone when smoothing is off and applies no transition without a rule', () => {
    const t0 = new Date(Date.UTC(2026, 9, 3))
    const vitals = Array.from({ length: 15 }, (_, m) => ({ timestamp: new Date(t0.getTime() + m * 60_000), heartRate: m >= 5 && m < 10 ? 48 : 60 + (m % 2), hrv: 40, breathingRate: 14 }))
    const ruleset = { ...DEFAULT_STAGE_RULESET, smoothIsolatedEpochs: false, transitions: [] }
    const epochs = classifyWithStageModel(forest(), t0, new Date(t0.getTime() + 15 * 60_000), vitals, [], ruleset)
    expect(epochs.map(e => e.stage)).toEqual(['light', 'deep', 'light'])
    expect(stageModelBlocks(epochs)).toHaveLength(3)
    // The filter nulls a reading outside the ruleset's limits before features are computed.
    const spiky = vitals.map((v, i) => (i === 0 ? { ...v, heartRate: 400, hrv: 5000, breathingRate: 99 } : v))
    const filtered = filterModelOutliers(spiky, DEFAULT_STAGE_RULESET.outliers)
    expect(filtered[0]).toMatchObject({ heartRate: null, hrv: null, breathingRate: null })
    expect(filterModelOutliers(spiky, { ...DEFAULT_STAGE_RULESET.outliers, heartRateSpikeStdDevs: 0 })[1].heartRate).toBe(61)
  })
})
