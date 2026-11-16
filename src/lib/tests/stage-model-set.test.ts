import { describe, expect, it } from 'vitest'
import { configHash } from '@/src/biometrics/algorithms/canonical'
import { stageModelContract, stageModelSchema } from '../personal-stage-model'
import { inputMismatch, modelSetProblem, modelSetSchema, stageModelSha256, type ModelSet } from '../stage-model-set'

const model = stageModelSchema.parse({
  version: 'test-forest',
  kind: 'forest',
  classes: ['wake', 'light', 'deep', 'rem'],
  featureContract: ['hrZ', 'hrStdZ', 'motionZ', 'nightFraction'],
  trees: [{ f: [0, -1, -1], t: [-0.5, 0, 0], l: [1, -1, -1], r: [2, -1, -1], v: [[0, 0, 0, 0], [0, 1, 9, 0], [1, 8, 1, 0]] }],
  testVectors: [
    { inputs: { hrZ: -1, hrStdZ: 0, motionZ: 0, nightFraction: 0.5 }, expected: 2 },
    { inputs: { hrZ: 1, hrStdZ: 0, motionZ: 0, nightFraction: 0.5 }, expected: 1 },
  ],
  metrics: { kappa: 0.1, note: 'é' },
})
const ENGINE = 'a'.repeat(64)
const PROFILE = 'b'.repeat(64)
const set = (nodes: Partial<ModelSet['nodes']> = {}): ModelSet => modelSetSchema.parse({
  formatVersion: 'modelset-v1',
  id: 'left-podContext-20261115',
  nodes: { stage: { version: model.version, sha256: stageModelSha256(model), binding: 'pinned' }, ...nodes },
})

describe('stageModelSha256', () => {
  it('matches modules/common/biometrics/config.py canonical_json on the stored document', () => {
    // Python: config_hash({...candidate, "epochSeconds": 300}); keys sorted, exact decimal numbers, no whitespace.
    expect(stageModelSha256(model)).toBe('6fe42238f142207ca4016e4fe243a439e63e362043938fa15d4f09bdcf2c7906')
  })

  it('hashes forests far past the 20 000-node config budget', () => {
    const big = { ...model, trees: Array.from({ length: 1000 }, () => model.trees ?? []).flat() }
    expect(() => configHash(big)).toThrow('JSON resource limit')
    expect(stageModelSha256(big)).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('modelSetSchema', () => {
  it('keeps training and evaluation as given and refuses other bindings', () => {
    const parsed = modelSetSchema.parse({ ...set(), training: { nights: { count: 38 }, inputs: 'replayed' }, evaluation: { holdoutScored: true } })
    expect(parsed.training).toEqual({ nights: { count: 38 }, inputs: 'replayed' })
    expect(modelSetSchema.safeParse({ ...set(), formatVersion: 'modelset-v2' }).success).toBe(false)
    expect(modelSetSchema.safeParse({ ...set(), nodes: { ...set().nodes, vitals: { engine: ENGINE, profile: PROFILE, binding: 'pinned' } } }).success).toBe(false)
    expect(modelSetSchema.safeParse({ ...set(), nodes: { ...set().nodes, stage: { ...set().nodes.stage, binding: 'expected' } } }).success).toBe(false)
    expect(modelSetSchema.safeParse({ ...set(), nodes: { ...set().nodes, stage: { ...set().nodes.stage, sha256: 'ABC' } } }).success).toBe(false)
    expect(modelSetSchema.safeParse({ ...set(), training: { blob: 'x'.repeat(70_000) } }).success).toBe(false)
  })
})

describe('modelSetProblem', () => {
  const contract = stageModelContract(model)

  it('accepts a set pinning this exact model', () => {
    expect(modelSetProblem(set(), model, contract)).toBeNull()
    expect(modelSetProblem(set({ stage: { ...set().nodes.stage, contract: 'challenger' } }), model, contract)).toBeNull()
  })

  it('refuses another model, version or contract, and any movement model', () => {
    expect(modelSetProblem(set({ stage: { ...set().nodes.stage, sha256: 'c'.repeat(64) } }), model, contract)).toMatch(/hashes to 6fe42238/)
    expect(modelSetProblem(set({ stage: { ...set().nodes.stage, version: 'other' } }), model, contract)).toMatch(/stage version other/)
    expect(modelSetProblem(set({ stage: { ...set().nodes.stage, contract: 'podContext' } }), model, contract)).toMatch(/contract podContext/)
    expect(modelSetProblem(set({ movementModel: { version: 'movementRaw-v1', sha256: 'd'.repeat(64), binding: 'pinned' } }), model, contract))
      .toMatch(/^Movement models are not supported on this pod yet/)
  })
})

describe('inputMismatch', () => {
  const vitals = { engine: ENGINE, profile: PROFILE, binding: 'expected' as const }

  it('flags only a set with a vitals node whose inputs differ', () => {
    expect(inputMismatch(null, { engine: ENGINE, profile: PROFILE })).toBeNull()
    expect(inputMismatch(set(), 'mixed')).toBeNull()
    expect(inputMismatch(set({ vitals }), null)).toBeNull()
    expect(inputMismatch(set({ vitals }), { engine: ENGINE, profile: PROFILE })).toBeNull()
    const expected = { engine: ENGINE, profile: PROFILE }
    expect(inputMismatch(set({ vitals }), { engine: ENGINE, profile: 'e'.repeat(64) })).toEqual({ expected, actual: { engine: ENGINE, profile: 'e'.repeat(64) } })
    expect(inputMismatch(set({ vitals }), 'mixed')).toEqual({ expected, actual: 'mixed' })
    expect(inputMismatch(set({ vitals }), 'unknown')).toEqual({ expected, actual: 'unknown' })
  })
})
