import { z } from 'zod'

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const rawArtifactDescriptorSchema = z.object({
  name: z.string(), sha256: hash, compressed_bytes: integer, expanded_bytes: integer,
}).strict().refine(value => value.name === `${value.sha256}.RAW.gz`, 'Artifact name must match its content hash')
const context = z.object({
  start_ms: integer, end_ms: integer,
  active_sides: z.array(z.enum(['left', 'right'])).max(2).nullable().refine(value => value === null
    || value.length < 2 || (value[0] === 'left' && value[1] === 'right'), 'Invalid recorded sleeper mode'),
  left_occupied: z.boolean().nullable(), right_occupied: z.boolean().nullable(), pump_context_known: z.boolean(),
}).strict()

/** The same immutable input envelope consumed by the shipped Python driver. */
export const retainedWaveformInputSchema = z.object({
  version: z.literal('retained-waveform-input-v1'),
  retained_start_ms: integer, score_start_ms: integer, score_end_ms: integer,
  artifacts: z.array(z.object({ artifact: rawArtifactDescriptorSchema, first_event_ms: integer, last_event_ms: integer }).strict()).min(1).max(64),
  contexts: z.array(context).max(20000),
}).strict().superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message })
  if (!(value.retained_start_ms <= value.score_start_ms && value.score_start_ms < value.score_end_ms)) invalid('Invalid retained replay window')
  const hashes = new Set<string>()
  let previous = -1, compressed = 0
  for (const source of value.artifacts) {
    if (source.first_event_ms > source.last_event_ms || source.last_event_ms < value.retained_start_ms || source.first_event_ms >= value.score_end_ms) invalid('Artifact has no events in the retained window')
    // Bounds may touch: Pod 5 can end one archive with a pump record stamped at the next archive's first frame.
    if (hashes.has(source.artifact.sha256) || source.first_event_ms < previous) invalid('Retained artifacts must be distinct with nonoverlapping ordered event bounds')
    hashes.add(source.artifact.sha256)
    previous = source.last_event_ms
    compressed += source.artifact.compressed_bytes
  }
  if (compressed > 1024 * 1024 * 1024) invalid('Retained replay compressed input budget exceeded')
  previous = value.retained_start_ms
  for (const interval of value.contexts) {
    if (interval.start_ms < previous || interval.start_ms >= interval.end_ms || interval.end_ms > value.score_end_ms) invalid('Context intervals must be ordered and nonoverlapping inside the retained window')
    previous = interval.end_ms
  }
})

export const waveformDatasetInputsSchema = z.array(z.object({
  cohortId: z.string().min(1).max(200), input: retainedWaveformInputSchema,
}).strict()).min(1).max(60).superRefine((value, ctx) => {
  if (new Set(value.map(item => item.cohortId)).size !== value.length) ctx.addIssue({ code: 'custom', message: 'Select each waveform cohort once' })
  const artifacts = new Map<string, string>()
  let compressed = 0
  for (const cohort of value) {
    for (const source of cohort.input.artifacts) {
      const previous = artifacts.get(source.artifact.sha256)
      const encoded = JSON.stringify(source)
      if (previous && previous !== encoded) ctx.addIssue({ code: 'custom', message: 'Conflicting evidence for shared waveform artifact' })
      if (!previous) compressed += source.artifact.compressed_bytes
      artifacts.set(source.artifact.sha256, encoded)
    }
  }
  if (artifacts.size > 1024 || compressed > 1024 * 1024 * 1024) ctx.addIssue({ code: 'custom', message: 'Waveform dataset RAW storage budget exceeded' })
})
