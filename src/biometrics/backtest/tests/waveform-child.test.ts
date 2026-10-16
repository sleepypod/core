// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runWaveformChild } from '../waveform-child'

let directory: string
let executable: string
const hash = 'a'.repeat(64)
const reading = { side: 'left', timestampMs: 1000, heartRate: 60, hrvIndex: null, hrvMetric: 'window_ibi_variability_v1',
  breathingRate: 12, qualityScore: 0.8, flags: null, hrRaw: 60, sourceSide: 'left', configHash: hash, limitations: [] }
const result = { version: 'retained-waveform-run-v1', build_hash: hash, decoded_records: 1, raw_records: 1,
  counts: { records: 1, accepted_frames: 1, empty_channel_frames: 0, pump_gated_frames: 0, preroll_outputs: 0, scored_outputs: 1 },
  limitations: [], config_hashes: { left: hash, right: hash }, artifact_hashes: [hash] }
const events = [{ type: 'reading', reading }, { type: 'result', result }]
const location = () => ({ pythonPath: executable, modulesPath: directory, retainedDirectory: directory })
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'waveform-child-'))
  executable = join(directory, 'fixture-worker')
})
afterEach(() => rm(directory, { recursive: true, force: true }))
async function worker(body: string) {
  await writeFile(executable, `#!${process.execPath}\nsetTimeout(() => process.exit(91), 3000).unref(); process.stdin.resume(); process.stdin.on('end', () => { ${body} });\n`, { mode: 0o700 })
}
const emit = (value: unknown) => `process.stdout.write(${JSON.stringify(JSON.stringify(value) + '\n')});`

it('passes a trusted CPU limit to the fixed worker and rejects invalid limits before spawning', async () => {
  await worker(`if (process.argv.slice(-2).join(' ') !== '--cpu-seconds 1800') process.exit(1); ${events.map(emit).join('')}`)
  expect(await runWaveformChild(location(), {}, { cpuSeconds: 1800 })).toEqual({ readings: [reading], run: result })
  for (const cpuSeconds of [0, -1, 1.5, NaN, Infinity, 3601]) {
    await expect(runWaveformChild(location(), {}, { cpuSeconds })).rejects.toThrow('Invalid waveform CPU budget')
  }
})

it('returns readings only after a valid success event and zero exit with a clean environment', async () => {
  await worker(`if (process.env.WAVEFORM_TEST_SECRET
    || JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(['-B', '-m', 'common.biometrics.replay_worker', '--retained-directory', directory]))}
    || process.env.PYTHONPATH !== ${JSON.stringify(directory)} || process.env.NODE_ENV !== 'production'
    || process.env.LANG !== 'C.UTF-8' || process.env.TZ !== 'UTC'
    || ['OPENBLAS_NUM_THREADS','OMP_NUM_THREADS','MKL_NUM_THREADS','NUMEXPR_NUM_THREADS'].some(key => process.env[key] !== '1')) process.exit(1);
    ${events.map(emit).join('')}`)
  process.env.WAVEFORM_TEST_SECRET = 'must not reach worker'
  try {
    expect(await runWaveformChild(location(), {})).toEqual({ readings: [reading], run: result })
  }
  finally {
    delete process.env.WAVEFORM_TEST_SECRET
  }
})

it.each([
  [events[0]],
  [...events, events[1]],
  [...events, events[0]],
  [events[0], { type: 'result', result: { ...result, counts: { ...result.counts, scored_outputs: 2 } } }],
  [{ type: 'reading', reading: { ...reading, configHash: 'b'.repeat(64) } }, events[1]],
  [{ type: 'reading', reading: { ...reading, hrvMetric: 'rmssd' } }, events[1]],
  [events[0], { type: 'result', result: { ...result, raw_records: 0 } }],
  [events[0], { type: 'result', result: { ...result, counts: { ...result.counts, records: 2 } } }],
  [events[0], { type: 'reading', reading: { ...reading, configHash: 'b'.repeat(64) } },
    { type: 'result', result: { ...result, counts: { ...result.counts, scored_outputs: 2 } } }],
].map(output => ({ output })))('rejects incomplete, inconsistent, or out-of-order protocol output %#', async ({ output }) => {
  await worker(output.map(emit).join(''))
  await expect(runWaveformChild(location(), {})).rejects.toThrow(/invalid event|incomplete result/)
})

it('rejects trailing partial data and nonzero exits even after a success event', async () => {
  await worker(`${events.map(emit).join('')} process.stdout.write('partial');`)
  await expect(runWaveformChild(location(), {})).rejects.toThrow('incomplete result')
  await worker(`${events.map(emit).join('')} process.stdout.write(Buffer.from([0xc3]));`)
  await expect(runWaveformChild(location(), {})).rejects.toThrow('incomplete result')
  await worker(`${events.map(emit).join('')} process.exitCode = 1;`)
  await expect(runWaveformChild(location(), {})).rejects.toThrow('incomplete result')
})

it('bounds individual output events, diagnostics and serialized input', async () => {
  await worker('process.stdout.write(\'x\'.repeat(70000));')
  await expect(runWaveformChild(location(), {})).rejects.toThrow('event exceeds')
  await worker('process.stderr.write(\'x\'.repeat(17000));')
  await expect(runWaveformChild(location(), {})).rejects.toThrow('diagnostic output')
  await expect(runWaveformChild(location(), 'x'.repeat(8 * 1024 * 1024))).rejects.toThrow('input exceeds')
})

it('kills overdue and cancelled work and handles missing executables', async () => {
  await worker('setInterval(() => {}, 1000);')
  await expect(runWaveformChild(location(), {}, { timeoutMs: 30 })).rejects.toThrow('time budget')
  const controller = new AbortController()
  const pending = runWaveformChild(location(), {}, { signal: controller.signal })
  controller.abort()
  await expect(pending).rejects.toThrow('cancelled')
  await expect(runWaveformChild(location(), {}, { signal: controller.signal })).rejects.toThrow('cancelled')
  await expect(runWaveformChild({ ...location(), pythonPath: join(directory, 'missing') }, {})).rejects.toThrow('could not start')
})

it('escalates cancellation when a running worker ignores SIGTERM', async () => {
  const ready = join(directory, 'ready')
  await worker(`process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`)
  const controller = new AbortController()
  const pending = runWaveformChild(location(), {}, { signal: controller.signal })
  const rejected = expect(pending).rejects.toThrow('cancelled')
  await vi.waitFor(async () => expect(Number(await readFile(ready, 'utf8'))).toBeGreaterThan(0), { timeout: 1500 })
  const pid = Number(await readFile(ready, 'utf8'))
  const started = performance.now()
  controller.abort()
  await rejected
  expect(performance.now() - started).toBeLessThan(1500)
  expect(() => process.kill(pid, 0)).toThrow()
})

it('enforces time-budget bounds while accepting their exact endpoints', async () => {
  await worker(events.map(emit).join(''))
  for (const timeoutMs of [0, 9, 1.5, Infinity, NaN, 3600001]) {
    await expect(runWaveformChild(location(), {}, { timeoutMs })).rejects.toThrow('Invalid waveform time budget')
  }
  expect(await runWaveformChild(location(), {}, { timeoutMs: 3600000 })).toEqual({ readings: [reading], run: result })
  await worker('setInterval(() => {}, 1000);')
  await expect(runWaveformChild(location(), {}, { timeoutMs: 10 })).rejects.toThrow('exceeded its time budget')
})

it('accepts exact input and diagnostic byte budgets', async () => {
  await worker(`process.stderr.write('x'.repeat(16384)); ${events.map(emit).join('')}`)
  expect(await runWaveformChild(location(), 'x'.repeat(8 * 1024 * 1024 - 2))).toEqual({ readings: [reading], run: result })
})

it('rejects empty event lines without treating them as absent output', async () => {
  await worker(`process.stdout.write('\\n'); ${events.map(emit).join('')}`)
  await expect(runWaveformChild(location(), {})).rejects.toThrow('invalid event')
})

it('rejects excessive valid readings before exposing a result', async () => {
  await worker(`for (let i=0; i<20001; i++) { ${emit(events[0])} }
    ${emit({ type: 'result', result: { ...result, counts: { ...result.counts, scored_outputs: 20001 } } })}`)
  await expect(runWaveformChild(location(), {})).rejects.toThrow('invalid event')
})

it('bounds aggregate output even when every event is valid and small enough', async () => {
  const large = { type: 'reading', reading: { ...reading, limitations: Array.from({ length: 40 }, () => 'x'.repeat(200)) } }
  await worker(`for (let i=0; i<2500; i++) { ${emit(large)} }
    ${emit({ type: 'result', result: { ...result, counts: { ...result.counts, scored_outputs: 2500 } } })}`)
  await expect(runWaveformChild(location(), {})).rejects.toThrow('output exceeds 16 MiB')
})

it('pins the requested Python build in the envelope and rejects mismatched completion', async () => {
  await writeFile(executable, `#!${process.execPath}\nlet input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{if(JSON.parse(input).expected_build_hash!==${JSON.stringify(hash)})process.exitCode=1;${events.map(emit).join('')}});`, { mode: 0o700 })
  expect((await runWaveformChild(location(), {}, { expectedBuildHash: hash })).run.build_hash).toBe(hash)
  await worker(events.map(emit).join(''))
  await expect(runWaveformChild(location(), {}, { expectedBuildHash: 'b'.repeat(64) })).rejects.toThrow('incomplete result')
  expect(() => runWaveformChild(location(), {}, { expectedBuildHash: 'invalid' })).toThrow()
})

it('retains valid measured process resources and rejects fabricated scopes or negative counts', async () => {
  const resources = { version: 'waveform-process-resources-v1', wallMs: 120, cpuMs: 80, peakRssBytes: 102400,
    scope: 'python_process_until_result', memoryScope: 'process_lifetime_high_water_mark' }
  await worker([events[0], { type: 'result', result: { ...result, resources } }].map(emit).join(''))
  expect((await runWaveformChild(location(), {})).run.resources).toEqual(resources)
  for (const patch of [{ wallMs: -1 }, { cpuMs: -1 }, { peakRssBytes: 0 }, { scope: 'whole_job' }]) {
    await worker([events[0], { type: 'result', result: { ...result, resources: { ...resources, ...patch } } }].map(emit).join(''))
    await expect(runWaveformChild(location(), {})).rejects.toThrow('invalid event')
  }
})

it('accepts Pod 5 runs that decode more records than frames, but not records without any frame', async () => {
  const packed = { ...result, decoded_records: 3, raw_records: 1 }
  await worker([{ type: 'reading', reading }, { type: 'result', result: packed }].map(emit).join(''))
  expect((await runWaveformChild(location(), {})).run).toEqual(packed)
  await worker([{ type: 'reading', reading }, { type: 'result', result: { ...result, raw_records: 0 } }].map(emit).join(''))
  await expect(runWaveformChild(location(), {})).rejects.toThrow('incomplete result')
})
