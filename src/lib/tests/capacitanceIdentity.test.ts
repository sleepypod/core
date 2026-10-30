import { describe, expect, it } from 'vitest'
import cases from '../../../modules/common/biometrics/adaptive-calibration-epoch-v1.json'
import { capacitanceSourceKey } from '../capacitanceIdentity'
import { parseCapacitanceCalibration } from '../capacitanceLevel'

function profileFor(sample: typeof cases[number], means = sample.means) {
  return {
    format: sample.format, source: 'adaptive', threshold: sample.threshold,
    channels: Object.fromEntries(sample.names.map((name, index) => [name, { mean: means[index] }])),
    ref: { mean: sample.referenceMean },
    qualification_epoch: { version: 1, id: '0123456789abcdef0123456789abcdef', format: sample.format,
      means: sample.means, threshold: sample.threshold, referenceMean: sample.referenceMean },
  }
}

function key(profile: unknown, format: string, side: 'left' | 'right' = 'left') {
  const calibration = parseCapacitanceCalibration(profile, format as 'capSense' | 'capSense2')
  expect(calibration).not.toBeNull()
  if (!calibration) throw new Error('Expected a usable calibration fixture')
  return capacitanceSourceKey(side, profile, calibration)
}

describe.each(cases)('$format adaptive qualification identity', (sample) => {
  it('retains identity through bounded publications and serialized reloads', () => {
    const original = key(profileFor(sample), sample.format)
    expect(original).toMatch(/^[a-f0-9]{64}$/)
    for (const means of [sample.inside, sample.boundary, sample.inside]) {
      const published = JSON.parse(JSON.stringify(profileFor(sample, means)))
      expect(key(published, sample.format)).toBe(original)
    }
    expect(key(profileFor(sample), sample.format, 'right')).not.toBe(original)
  })

  it('withholds a qualifying key beyond the fixed anchor budget', () => {
    expect(key(profileFor(sample, sample.outside), sample.format)).toBeNull()
  })

  it('requires matching epoch parameters and invalidates renewed anchors', () => {
    const original = profileFor(sample)
    const threshold = structuredClone(original)
    threshold.threshold += 1
    expect(key(threshold, sample.format)).toBeNull()
    const reference = structuredClone(original)
    reference.ref.mean += 1
    expect(key(reference, sample.format)).toBeNull()
    const changed = profileFor(sample, sample.inside)
    changed.qualification_epoch.means = sample.inside
    expect(key(changed, sample.format)).not.toBe(key(original, sample.format))
    const recalibrated = structuredClone(original)
    recalibrated.qualification_epoch.id = 'fedcba9876543210fedcba9876543210'
    expect(key(recalibrated, sample.format)).not.toBe(key(original, sample.format))
  })

  it.each([null, {}, { version: 2 }, { version: true }, { version: 1, id: 'bad' }])('fails closed for malformed epoch %j', (epoch) => {
    const profile = { ...profileFor(sample), qualification_epoch: epoch }
    expect(key(profile, sample.format)).toBeNull()
  })

  it('retains strict matching for older producers without epoch metadata', () => {
    const { qualification_epoch: omitted, ...original } = profileFor(sample)
    const { qualification_epoch: alsoOmitted, ...drifted } = profileFor(sample, sample.inside)
    expect(omitted).toEqual(alsoOmitted)
    expect(key(original, sample.format)).not.toBe(key(drifted, sample.format))
  })
})
