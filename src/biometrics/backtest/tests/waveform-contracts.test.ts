// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { rawArtifactDescriptorSchema, retainedWaveformInputSchema, waveformDatasetInputsSchema } from '../waveform-contracts'

const hash = (char: string) => char.repeat(64)
const artifact = (char: string, compressed = 10) => ({ name: `${hash(char)}.RAW.gz`, sha256: hash(char), compressed_bytes: compressed, expanded_bytes: 20 })
const source = (char: string, first: number, last: number, compressed = 10) => ({ artifact: artifact(char, compressed), first_event_ms: first, last_event_ms: last })
const input = (changes: Record<string, unknown> = {}) => ({ version: 'retained-waveform-input-v1', retained_start_ms: 1000, score_start_ms: 2000, score_end_ms: 5000,
  artifacts: [source('a', 1000, 3000), source('b', 3500, 6000)], contexts: [], ...changes })
const context = (start: number, end: number, changes: Record<string, unknown> = {}) => ({ start_ms: start, end_ms: end, active_sides: null, left_occupied: null, right_occupied: null, pump_context_known: false, ...changes })

describe('retained waveform input contract', () => {
  it('accepts an ordered envelope with ordered nonoverlapping contexts and either sleeper mode', () => {
    const parsed = retainedWaveformInputSchema.parse(input({ contexts: [context(1000, 2000, { active_sides: ['left'] }), context(2000, 2500, { active_sides: ['left', 'right'], left_occupied: true, right_occupied: false, pump_context_known: true }), context(4000, 5000, { active_sides: [] })] }))
    expect(parsed.contexts).toHaveLength(3)
  })
  it('requires artifact names to match their content hash', () => {
    expect(() => rawArtifactDescriptorSchema.parse({ ...artifact('a'), name: `${hash('b')}.RAW.gz` })).toThrow('content hash')
    expect(() => rawArtifactDescriptorSchema.parse({ ...artifact('a'), sha256: 'short' })).toThrow()
  })
  it('rejects reversed, swapped and overlapping replay windows and event bounds', () => {
    expect(() => retainedWaveformInputSchema.parse(input({ retained_start_ms: 2500 }))).toThrow('Invalid retained replay window')
    expect(() => retainedWaveformInputSchema.parse(input({ score_end_ms: 2000 }))).toThrow('Invalid retained replay window')
    expect(() => retainedWaveformInputSchema.parse(input({ artifacts: [source('a', 3000, 1000)] }))).toThrow('no events in the retained window')
    expect(() => retainedWaveformInputSchema.parse(input({ artifacts: [source('a', 100, 900)] }))).toThrow('no events in the retained window')
    expect(() => retainedWaveformInputSchema.parse(input({ artifacts: [source('a', 5000, 6000)] }))).toThrow('no events in the retained window')
    expect(() => retainedWaveformInputSchema.parse(input({ artifacts: [source('a', 1000, 3000), source('a', 3500, 6000)] }))).toThrow('distinct with nonoverlapping ordered')
    expect(() => retainedWaveformInputSchema.parse(input({ artifacts: [source('a', 1000, 3000), source('b', 2999, 6000)] }))).toThrow('distinct with nonoverlapping ordered')
    // Pod 5 archives can share their boundary millisecond.
    expect(retainedWaveformInputSchema.parse(input({ artifacts: [source('a', 1000, 3000), source('b', 3000, 6000)] })).artifacts).toHaveLength(2)
    expect(() => retainedWaveformInputSchema.parse(input({ artifacts: [source('a', 1000, 3000, 1024 * 1024 * 1024 + 1)] }))).toThrow('compressed input budget')
    expect(() => retainedWaveformInputSchema.parse(input({ artifacts: [] }))).toThrow()
  })
  it('rejects contexts that start before the retained window, run backwards, overlap or outlive scoring', () => {
    expect(() => retainedWaveformInputSchema.parse(input({ contexts: [context(500, 1500)] }))).toThrow('Context intervals')
    expect(() => retainedWaveformInputSchema.parse(input({ contexts: [context(1500, 1500)] }))).toThrow('Context intervals')
    expect(() => retainedWaveformInputSchema.parse(input({ contexts: [context(1000, 2000), context(1500, 2500)] }))).toThrow('Context intervals')
    expect(() => retainedWaveformInputSchema.parse(input({ contexts: [context(4000, 5001)] }))).toThrow('Context intervals')
    expect(() => retainedWaveformInputSchema.parse(input({ contexts: [context(1000, 2000, { active_sides: ['right', 'left'] })] }))).toThrow('sleeper mode')
    expect(() => retainedWaveformInputSchema.parse(input({ contexts: [context(1000, 2000, { active_sides: ['left', 'left'] })] }))).toThrow('sleeper mode')
  })
})

describe('waveform dataset inputs contract', () => {
  const cohort = (cohortId: string, changes: Record<string, unknown> = {}) => ({ cohortId, input: input(changes) })
  it('accepts shared artifacts with identical evidence and counts shared bytes once', () => {
    expect(waveformDatasetInputsSchema.parse([cohort('one'), cohort('two')])).toHaveLength(2)
    const half = 600 * 1024 * 1024
    expect(waveformDatasetInputsSchema.parse([cohort('one', { artifacts: [source('a', 1000, 3000, half)] }), cohort('two', { artifacts: [source('a', 1000, 3000, half)] })])).toHaveLength(2)
  })
  it('rejects repeated cohorts, conflicting shared artifact evidence and storage over budget', () => {
    expect(() => waveformDatasetInputsSchema.parse([cohort('one'), cohort('one')])).toThrow('Select each waveform cohort once')
    expect(() => waveformDatasetInputsSchema.parse([cohort('one'), cohort('two', { artifacts: [source('a', 1000, 2999)] })])).toThrow('Conflicting evidence')
    const half = 600 * 1024 * 1024
    expect(() => waveformDatasetInputsSchema.parse([cohort('one', { artifacts: [source('a', 1000, 3000, half)] }), cohort('two', { artifacts: [source('b', 1000, 3000, half)] })])).toThrow('RAW storage budget')
    expect(() => waveformDatasetInputsSchema.parse([])).toThrow()
  })
})
