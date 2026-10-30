// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultConfig } from '../../algorithms/registry'
import { configHash } from '../../algorithms/canonical'
import { ShadowWorkerProtocol } from '../worker-protocol'

const hash = 'a'.repeat(64), start = 1700000000000
const expected = { runId: randomUUID(), attemptId: randomUUID(), side: 'left', startMs: start, endMs: start + 150000,
  configHashes: { left: hash, right: hash }, maximumRecords: 200, maximumOutputs: 10, maximumCpuMs: 30000 }
function fixture() {
  const protocol = new ShadowWorkerProtocol(expected)
  const ready = { type: 'ready', runId: expected.runId, attemptId: expected.attemptId, configHashes: expected.configHashes }
  const output = { sequence: 0, inputHash: hash, side: 'left', sourceSide: 'right', timestampBasis: 'firmware_event_time_v1', timestampMs: start, configHash: hash,
    readings: [{ metric: 'heart_rate', unit: 'bpm', windowMs: null, value: 60, quality: 1 },
      { metric: 'breathing_rate', unit: 'breaths/min', windowMs: null, value: null, quality: 0 },
      { metric: 'window_ibi_variability_v1', unit: 'ms', windowMs: 300000, value: null, quality: 0 }], flags: null, limitations: ['cold_start_without_serialized_state'] }
  const frame = { type: 'frame_result', runId: expected.runId, attemptId: expected.attemptId, sequence: 0, outputs: [output],
    health: { timestampBasis: 'firmware_event_time_v1', state: 'running', reason: null, records: 1, outputs: 1, cpu_ms: 1, input_hash: hash, limitations: [],
      counts: { mechanical_gated_frames: 0, timestamp_rejected_frames: 0, records: 1, accepted_frames: 1, empty_channel_frames: 0, pump_gated_frames: 0, preroll_outputs: 0, scored_outputs: 1 } } }
  return { protocol, ready, frame }
}
describe('shadow worker response validation', () => {
  it('requires matching initialization and validates a complete typed batch', () => {
    const { protocol, ready, frame } = fixture()
    expect(() => protocol.accept(frame, 'frame_result')).toThrow('initialization')
    protocol.accept(ready, 'ready')
    expect(protocol.accept(frame, 'frame_result')).toMatchObject({ outputs: [{ side: 'left', sourceSide: 'right' }] })
    expect(() => protocol.accept(frame, 'frame_result')).toThrow('sequence')
  })
  it('rejects stale identities, side/config/window changes, metric substitutions and forged health without advancing', () => {
    const { protocol, ready, frame } = fixture()
    protocol.accept(ready, 'ready')
    for (const changed of [{ ...frame, attemptId: randomUUID() }, { ...frame, sequence: 1 },
      { ...frame, health: { ...frame.health, timestampBasis: undefined } },
      { ...frame, health: { ...frame.health, counts: { ...frame.health.counts, timestamp_rejected_frames: undefined } } },
      { ...frame, health: { ...frame.health, counts: { ...frame.health.counts, timestamp_rejected_frames: 1 } } },
      { ...frame, health: { ...frame.health, outputs: 2 } }, { ...frame, health: { ...frame.health, cpu_ms: 30001 } }]) {
      expect(() => protocol.accept(changed, 'frame_result')).toThrow()
    }
    for (const changes of [{ timestampBasis: 'processing_clock' }, { timestampBasis: undefined }, { side: 'right' }, { configHash: 'b'.repeat(64) }, { timestampMs: start - 1 }, { timestampMs: expected.endMs },
      { readings: frame.outputs[0].readings.map(row => row.metric === 'window_ibi_variability_v1' ? { ...row, metric: 'hrv_rmssd' } : row) }]) {
      expect(() => protocol.accept({ ...frame, outputs: [{ ...frame.outputs[0], ...changes }] }, 'frame_result')).toThrow()
    }
    expect(protocol.accept(frame, 'frame_result').type).toBe('frame_result')
  })
  it('requires the requested terminal command and closes after acknowledgment', () => {
    const { protocol, ready, frame } = fixture()
    protocol.accept(ready, 'ready')
    protocol.accept(frame, 'frame_result')
    const finish = { type: 'finished', runId: expected.runId, attemptId: expected.attemptId, outputs: [], health: { ...frame.health, state: 'completed' } }
    expect(() => protocol.accept(finish, 'frame_result')).toThrow('command')
    protocol.accept(finish, 'finished')
    expect(() => protocol.accept(frame, 'frame_result')).toThrow('completion')
  })
})
const python = resolve('modules/piezo-processor/.venv/bin/python')
it.skipIf(!existsSync(python))('validates actual locked-Python worker output across the process boundary', () => {
  const configs = { left: defaultConfig, right: defaultConfig }
  const configHashes = { left: configHash(defaultConfig), right: configHash(defaultConfig) }
  const init = { ...expected, configHashes, schema: 'biometric-shadow-worker-v1', configs,
    maximumInputBytes: 2 * 1024 * 1024, maximumOutputBytes: 512 * 1024 }
  const messages: unknown[] = [init]
  for (let second = 0; second < 150; second++) {
    const left = Buffer.alloc(2000)
    for (let index = 0; index < 500; index++) left.writeInt32LE(Math.trunc(Math.sin((second * 500 + index) / 500 * 2 * Math.PI * 1.2) * 1000000), index * 4)
    messages.push({ type: 'frame', sequence: second, observedAtMs: start + second * 1000,
      record: { type: 'piezo-dual', ts: start / 1000 + second, left1: left.toString('base64'), right1: Buffer.alloc(2000).toString('base64') },
      context: { activeSides: ['left'], leftOccupied: true, rightOccupied: false, pumpContextKnown: true,
        mechanical: quietMechanicalSnapshot(start + second * 1000) } })
  }
  messages.push({ type: 'finish' })
  const result = spawnSync(python, ['-m', 'common.biometrics.shadow_worker'], { env: { ...process.env, PYTHONPATH: resolve('modules') },
    input: messages.map(message => JSON.stringify(message)).join('\n') + '\n', encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 })
  expect(result.status, result.stderr).toBe(0)
  const replies = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  const protocol = new ShadowWorkerProtocol({ ...expected, configHashes })
  let outputs = 0
  replies.forEach((reply, index) => {
    const result = protocol.accept(reply, index === 0 ? 'ready' : index === replies.length - 1 ? 'finished' : 'frame_result')
    if ('outputs' in result) outputs += result.outputs.length
  })
  expect(replies).toHaveLength(152)
  expect(outputs).toBeGreaterThan(0)
}, 30000)
import { quietMechanicalSnapshot } from '../../mechanical/tests/fixtures'
