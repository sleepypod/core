import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyWithStageModel,
  evaluateStageModel,
  failingTestVectors,
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
