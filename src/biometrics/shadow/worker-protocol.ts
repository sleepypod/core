import { z } from 'zod'
import { configHash } from '../algorithms/canonical'

export const firmwareTimestampBasis = 'firmware_event_time_v1' as const

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const side = z.enum(['left', 'right'])
const reading = { value: z.number().finite().nullable(), quality: z.number().min(0).max(1) }
const metricReading = z.discriminatedUnion('metric', [
  z.object({ metric: z.literal('heart_rate'), unit: z.literal('bpm'), windowMs: z.null(), ...reading }).strict(),
  z.object({ metric: z.literal('breathing_rate'), unit: z.literal('breaths/min'), windowMs: z.null(), ...reading }).strict(),
  z.object({ metric: z.literal('window_ibi_variability_v1'), unit: z.literal('ms'), windowMs: z.literal(300000), ...reading }).strict(),
])
export const shadowWorkerOutputSchema = z.object({ sequence: integer, inputHash: hash, side, sourceSide: side,
  timestampMs: integer, timestampBasis: z.literal(firmwareTimestampBasis), configHash: hash, readings: z.array(metricReading).length(3),
  flags: z.array(z.string().max(200)).max(32).nullable(), limitations: z.array(z.string().max(200)).max(32),
}).strict().refine(output => new Set(output.readings.map(row => row.metric)).size === 3, 'All typed metrics required')
// New context fields are optional only for historical receipts; current replies require them.
export const shadowWorkerHealthSchema = z.object({ timestampBasis: z.literal(firmwareTimestampBasis).optional(), state: z.enum(['running', 'completed', 'stopped']), reason: z.string().max(500).nullable(),
  records: integer, outputs: integer, cpu_ms: z.number().finite().nonnegative(), input_hash: hash,
  counts: z.object({ mechanical_gated_frames: integer.optional(), timestamp_rejected_frames: integer.optional(), records: integer, accepted_frames: integer, empty_channel_frames: integer,
    pump_gated_frames: integer, preroll_outputs: integer, scored_outputs: integer }).strict(),
  limitations: z.array(z.string().max(200)).max(32),
}).strict()
const identity = { runId: z.string().uuid(), attemptId: z.string().uuid() }
const hashes = z.object({ left: hash, right: hash }).strict()
const responseSchema = z.discriminatedUnion('type', [
  z.object({ ...identity, type: z.literal('ready'), configHashes: hashes }).strict(),
  z.object({ ...identity, type: z.literal('frame_result'), sequence: integer, outputs: z.array(shadowWorkerOutputSchema).max(4), health: shadowWorkerHealthSchema }).strict(),
  z.object({ ...identity, type: z.literal('finished'), outputs: z.array(shadowWorkerOutputSchema).max(4), health: shadowWorkerHealthSchema }).strict(),
  z.object({ ...identity, type: z.literal('cancelled'), health: shadowWorkerHealthSchema }).strict(),
])
const expectedSchema = z.object({ ...identity, side, startMs: integer, endMs: integer, configHashes: hashes,
  maximumRecords: integer.positive(), maximumOutputs: integer.positive(), maximumCpuMs: integer.positive(),
}).strict().refine(value => value.startMs < value.endMs, 'Invalid shadow response window')

/** Stateful parent-side validation. A rejected batch changes no counters, so
 * callers cannot accidentally accept partial unvalidated output from a reply. */
export class ShadowWorkerProtocol {
  private readonly expected: z.infer<typeof expectedSchema>
  private ready = false
  private closed = false
  private records = 0
  private outputs = 0
  private lastTimestamp = -1
  private cpuMs = 0

  constructor(expected: unknown) {
    this.expected = expectedSchema.parse(structuredClone(expected))
  }

  accept(raw: unknown, expectedType: 'ready' | 'frame_result' | 'finished' | 'cancelled') {
    if (this.closed) throw new Error('Shadow response after completion')
    const response = responseSchema.parse(raw)
    const expected = this.expected
    if (response.runId !== expected.runId || response.attemptId !== expected.attemptId || response.type !== expectedType) throw new Error('Shadow response identity or command mismatch')
    if (response.type === 'ready') {
      if (this.ready || configHash(response.configHashes) !== configHash(expected.configHashes)) throw new Error('Shadow ready identity mismatch')
      this.ready = true
      return response
    }
    if (!this.ready) throw new Error('Shadow worker has not acknowledged initialization')
    const records = this.records + (response.type === 'frame_result' ? 1 : 0)
    if (response.type === 'frame_result' && response.sequence !== this.records) throw new Error('Shadow acknowledgment sequence mismatch')
    const batch = response.type === 'cancelled' ? [] : response.outputs
    const outputCount = this.outputs + batch.length
    if (records > expected.maximumRecords || outputCount > expected.maximumOutputs) throw new Error('Shadow response exceeds run quota')
    let timestamp = this.lastTimestamp
    for (const [index, output] of batch.entries()) {
      if (output.sequence !== this.outputs + index || output.side !== expected.side || output.configHash !== expected.configHashes[expected.side]
        || output.timestampMs < expected.startMs || output.timestampMs >= expected.endMs || output.timestampMs <= timestamp) throw new Error('Shadow output identity, order or window mismatch')
      timestamp = output.timestampMs
    }
    const health = response.health
    const state = response.type === 'frame_result' ? 'running' : response.type === 'finished' ? 'completed' : 'stopped'
    if (health.timestampBasis !== firmwareTimestampBasis || health.counts.timestamp_rejected_frames === undefined || health.counts.mechanical_gated_frames === undefined
      || health.state !== state || health.records !== records || health.counts.records !== records || health.outputs !== outputCount
      || health.cpu_ms < this.cpuMs || health.cpu_ms > expected.maximumCpuMs
      || health.counts.accepted_frames + health.counts.empty_channel_frames + health.counts.pump_gated_frames + (health.counts.timestamp_rejected_frames ?? 0) + (health.counts.mechanical_gated_frames ?? 0) > records
      || health.counts.scored_outputs < outputCount
      || health.counts.scored_outputs + health.counts.preroll_outputs > 2 * health.counts.accepted_frames
      || batch.some(output => output.inputHash !== health.input_hash)) throw new Error('Shadow health receipt inconsistent')
    this.records = records
    this.outputs = outputCount
    this.lastTimestamp = timestamp
    this.cpuMs = health.cpu_ms
    this.closed = response.type !== 'frame_result'
    return response
  }
}
