// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { canonicalJson, configHash } from '../canonical'
import { biometricManifest, defaultConfig, legacyStageOverrides, manifestHash, removeOverride, resolveConfig, validateConfig } from '../registry'
import { DEFAULT_STAGE_CLASSIFIER, stageClassifierSchema } from '@/src/lib/sleep-stage-rules'

const fixtures = [
  [],
  [{ path: 'heart_rate.trackingToleranceBpm', value: 20 }],
  [{ path: 'sleep_stages.ruleset.smoothIsolatedEpochs', value: false }, { path: 'sleep_stages.ruleset.lowSignalBelow', value: 0 }],
  [{ path: 'sleep_stages.ruleset.rules', value: [{ stage: 'wake', when: [] }, { stage: 'light', when: [] }] }],
  [{ path: 'sleep_stages.ruleset.rules', value: [] }],
  [{ path: 'heart_rate.trackingHistoryLength', value: 2.5 }],
  [{ path: 'heart_rate.trackingToleranceBpm', value: true }],
  [{ path: 'sleep_stages.ruleset.outliers.heartRate.min', value: 140 }],
  [{ path: 'sleep_stages.ruleset.rules.0.stage', value: 'rem' }],
  [{ path: 'sleep_stages.ruleset.rules', value: [{ stage: 'unknown', when: [] }] }],
  [{ path: 'sleep_stages.ruleset.fallback', value: null }],
  [{ path: 'heart_rate', value: { trackingToleranceBpm: 10 } }],
  [{ path: 'heart_rate.trackingToleranceBpm', value: 10 }, { path: 'heart_rate.trackingToleranceBpm', value: 12 }],
  [{ path: '__proto__.polluted', value: true }],
  [{ path: 'sleep_stages.ruleset.lowSignalBelow', value: 1.01 }],
  [{ path: 'sleep_stages.ruleset.rules', value: Array(33).fill({ stage: 'wake', when: [] }) }],
]

describe('versioned biometric contract', () => {
  // Stryker hashes its instrumented sandbox copy, so pinned source hashes can't match there.
  it.skipIf(process.env.STRYKER_MUTATOR_WORKER !== undefined)('pins the actual numerical source and locked dependency files', () => {
    for (const [path, hash] of Object.entries({ ...biometricManifest.sourceHashes, ...biometricManifest.dependencyHashes })) {
      expect(createHash('sha256').update(readFileSync(path)).digest('hex'), path).toBe(hash)
    }
  })

  it('preserves the shipped classifier and labels HRV correctly', () => {
    expect(resolveConfig([]).resolved.sleep_stages).toEqual(DEFAULT_STAGE_CLASSIFIER)
    expect(stageClassifierSchema.parse(defaultConfig.sleep_stages)).toEqual(defaultConfig.sleep_stages)
    expect(biometricManifest.components.hrv_index.metricId).toBe('window_ibi_variability_v1')
    expect(biometricManifest.components.sleep_stages.causal).toBe(false)
    expect(validateConfig(defaultConfig)).toEqual(defaultConfig)
  })

  it('keeps false/zero intent, replaces ordered arrays, and removes overrides explicitly', () => {
    const overrides = fixtures[2]
    const profile = resolveConfig(overrides)
    expect(profile.resolved.sleep_stages.ruleset.lowSignalBelow).toBe(0)
    expect(profile.resolved.sleep_stages.ruleset.smoothIsolatedEpochs).toBe(false)
    expect(resolveConfig(removeOverride(overrides, 'sleep_stages.ruleset.lowSignalBelow')).resolved.sleep_stages.ruleset.lowSignalBelow).toBe(0.3)
    expect(resolveConfig(fixtures[4]).resolved.sleep_stages.ruleset.rules).toEqual([])
    const reversed = structuredClone(fixtures[3])
    ;(reversed[0].value as unknown[]).reverse()
    expect(resolveConfig(reversed).hash).not.toBe(resolveConfig(fixtures[3]).hash)
    expect(() => {
      profile.resolved.heart_rate.trackingToleranceBpm = 25
    }).toThrow()
  })

  it('preserves every legacy leaf and first-match rule ordering', () => {
    const legacy = structuredClone(DEFAULT_STAGE_CLASSIFIER)
    legacy.ruleset.rules.reverse()
    legacy.ruleset.smoothIsolatedEpochs = false
    const result = resolveConfig(legacyStageOverrides(legacy))
    expect(result.resolved.sleep_stages).toEqual(legacy)
    expect(result.resolved.heart_rate).toEqual(defaultConfig.heart_rate)
    expect(() => resolveConfig([], 'unknown-engine')).toThrow('PROFILE_INCOMPATIBLE')
  })

  it('rejects every invalid contract fixture', () => {
    for (const fixture of fixtures.slice(5)) expect(() => resolveConfig(fixture)).toThrow()
    expect(() => validateConfig({ ...defaultConfig, sensorCalibration: {} })).toThrow()
  })

  it('matches Python validation and configuration hashes on the same fixtures', () => {
    const python = execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, 'modules')
from common.biometrics.config import resolve_config
results = []
for fixture in json.load(sys.stdin):
    try:
        result = resolve_config(fixture)
        results.append({'hash': result['hash'], 'manifestHash': result['manifestHash']})
    except ValueError:
        results.append(None)
print(json.dumps(results))
`], { input: JSON.stringify(fixtures), encoding: 'utf8' })
    expect(JSON.parse(python)).toEqual(fixtures.map((fixture) => {
      try {
        const result = resolveConfig(fixture)
        return { hash: result.hash, manifestHash }
      }
      catch { return null }
    }))
  })
})

describe('finite-binary64-json-v1', () => {
  it('uses deterministic key order and finite numeric JSON, preserving array order', () => {
    expect(canonicalJson({ b: -0, a: 0.5 })).toBe('{"a":0.5,"b":0}')
    expect(configHash({ a: 1, b: 2 })).toBe(configHash({ b: 2, a: 1 }))
    for (const invalid of [NaN, Infinity, undefined, new Date(), { a: undefined }, '\ud800', Array(2)]) {
      expect(() => canonicalJson(invalid)).toThrow()
    }
    expect(() => canonicalJson(Array(20001).fill(null))).toThrow('resource limit')
    let deep: unknown = null
    for (let i = 0; i < 33; i++) deep = [deep]
    expect(() => canonicalJson(deep)).toThrow('resource limit')
  })

  it('matches Python for float edge cases, control characters, and Unicode key order', () => {
    const values = [0.1, -0, 1e-7, 1e21, Number.MIN_VALUE, Number.MAX_VALUE, 1.23456789012345,
      { '\u{10000}': '🌙\n\t', '\ue000': 'é', '\u0000': '\b\f\r' }]
    const output = execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, 'modules')
from common.biometrics.config import canonical_json
print(json.dumps([canonical_json(v) for v in json.load(sys.stdin)], ensure_ascii=False))
`], { input: JSON.stringify(values), encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual(values.map(canonicalJson))
    for (const value of values) expect(JSON.parse(canonicalJson(value))).toEqual(value === 0 ? 0 : value)
  })
})

it.each([
  ['wrong object type', { ...defaultConfig, heart_rate: [] }],
  ['missing required property', { ...defaultConfig, heart_rate: { trackingToleranceBpm: 15 } }],
  ['null component', { ...defaultConfig, heart_rate: null }],
  ['wrong contract version', { ...defaultConfig, sleep_stages: { ...defaultConfig.sleep_stages, version: 99 } }],
])('rejects %s instead of silently filling an immutable snapshot', (_reason, config) => {
  expect(() => validateConfig(config)).toThrow()
})
it.each([
  { path: 'heart_rate.trackingToleranceBpm', value: 4 },
  { path: 'heart_rate.trackingToleranceBpm', value: 31 },
  { path: 'sleep_stages.ruleset.smoothIsolatedEpochs', value: 1 },
  { path: 'sleep_stages.ruleset.rules', value: {} },
  { path: 'sleep_stages.ruleset.rules', value: [null] },
  { path: 'sleep_stages.ruleset.rules', value: [{ stage: 'wake' }] },
  { path: '', value: 1 },
  { path: 'heart_rate.trackingToleranceBpm', value: 15, extra: true },
])('rejects malformed override $path with value $value', (override) => {
  expect(() => resolveConfig([override])).toThrow()
})
it('bounds override intake before resolving or mutating defaults', () => {
  expect(() => resolveConfig(Array.from({ length: 65 }, () => ({ path: 'heart_rate.trackingToleranceBpm', value: 15 })))).toThrow('maximum 64')
  expect(defaultConfig.heart_rate.trackingToleranceBpm).toBe(15)
})

it('validates constants, required keys, array bounds and string leaves from the manifest', () => {
  expect(() => validateConfig({ ...defaultConfig, sleep_stages: { ...defaultConfig.sleep_stages, engine: 'other' } })).toThrow('Invalid biometric parameter')
  expect(() => validateConfig({ ...defaultConfig, sleep_stages: { ...defaultConfig.sleep_stages, engine: 7 } })).toThrow('Invalid biometric parameter')
  const missing = Object.fromEntries(Object.entries(defaultConfig).filter(([key]) => key !== 'heart_rate'))
  expect(() => validateConfig(missing)).toThrow('Invalid biometric parameter')
  expect(() => validateConfig({ ...defaultConfig, heart_rate: [] })).toThrow('Invalid biometric parameter')
  const rules = Array.from({ length: 65 }, () => defaultConfig.sleep_stages.ruleset.rules[0])
  expect(() => validateConfig({ ...defaultConfig, sleep_stages: { ...defaultConfig.sleep_stages, ruleset: { ...defaultConfig.sleep_stages.ruleset, rules } } })).toThrow('Invalid biometric parameter')
  expect(() => validateConfig({ ...defaultConfig, sleep_stages: { ...defaultConfig.sleep_stages, ruleset: { ...defaultConfig.sleep_stages.ruleset, outliers: { ...defaultConfig.sleep_stages.ruleset.outliers, heartRate: { min: 100, max: 50 } } } } })).toThrow('Invalid ordered range')
})
