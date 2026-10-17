import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { tmpdir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'

import { waveformReadingSchema, waveformRunSchema } from './waveform-output'
export { waveformReadingSchema, waveformRunSchema } from './waveform-output'
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('reading'), reading: waveformReadingSchema }).strict(),
  z.object({ type: z.literal('result'), result: waveformRunSchema }).strict(),
])
export interface WaveformWorkerLocation {
  pythonPath: string
  modulesPath: string
  retainedDirectory: string
  /** Off-pod entry script that calls the same replay_worker.run(); unset on the pod. */
  script?: string
}

/** Locations are trusted server configuration, never fields accepted by RPC. */
export function runWaveformChild(location: WaveformWorkerLocation, work: unknown, options: {
  signal?: AbortSignal
  timeoutMs?: number
  expectedBuildHash?: string
  cpuSeconds?: number
} = {}): Promise<{ readings: z.infer<typeof waveformReadingSchema>[], run: z.infer<typeof waveformRunSchema> }> {
  if (options.cpuSeconds !== undefined && (location.script !== undefined || !Number.isSafeInteger(options.cpuSeconds) || options.cpuSeconds < 1 || options.cpuSeconds > 3600)) return Promise.reject(new Error('Invalid waveform CPU budget'))
  if (options.expectedBuildHash !== undefined) hash.parse(options.expectedBuildHash)
  const serialized = JSON.stringify(options.expectedBuildHash === undefined ? work : { ...z.record(z.string(), z.unknown()).parse(work), expected_build_hash: options.expectedBuildHash })
  if (!serialized || Buffer.byteLength(serialized) > 8 * 1024 * 1024) return Promise.reject(new Error('Waveform input exceeds 8 MiB'))
  const timeoutMs = options.timeoutMs ?? 120000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 3600000) return Promise.reject(new Error('Invalid waveform time budget'))
  if (options.signal?.aborted) return Promise.reject(new Error('Waveform replay cancelled'))
  return new Promise((resolve, reject) => {
    const entry = location.script === undefined ? ['-m', 'common.biometrics.replay_worker'] : [location.script]
    const child: ChildProcessWithoutNullStreams = spawn(location.pythonPath, ['-B', ...entry, '--retained-directory', location.retainedDirectory, ...(options.cpuSeconds === undefined ? [] : ['--cpu-seconds', String(options.cpuSeconds)])], {
      cwd: tmpdir(), env: { NODE_ENV: 'production', PYTHONPATH: location.modulesPath, LANG: 'C.UTF-8', TZ: 'UTC',
        OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const readings: z.infer<typeof waveformReadingSchema>[] = []
    let result: z.infer<typeof waveformRunSchema> | undefined
    const decoder = new StringDecoder('utf8')
    let pending = '', outputBytes = 0, diagnosticBytes = 0
    let failure: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = (error: Error) => {
      failure ??= error
      child.kill('SIGTERM')
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 500)
    }
    const timeout = setTimeout(() => stop(new Error('Waveform replay exceeded its time budget')), timeoutMs)
    const abort = () => stop(new Error('Waveform replay cancelled'))
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    child.on('error', () => stop(new Error('Waveform worker could not start')))
    child.stdin.on('error', () => stop(new Error('Waveform worker input pipe closed')))
    child.stderr.on('data', (chunk: Buffer) => {
      diagnosticBytes += chunk.length
      if (diagnosticBytes > 16384) stop(new Error('Waveform diagnostic output exceeded its bound'))
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return
      outputBytes += chunk.length
      if (outputBytes > 16 * 1024 * 1024) return stop(new Error('Waveform output exceeds 16 MiB'))
      pending += decoder.write(chunk)
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        try {
          if (result || Buffer.byteLength(line) > 65536) throw new Error('Invalid event order or length')
          const event = eventSchema.parse(JSON.parse(line))
          if (event.type === 'reading') {
            if (readings.length >= 20000) throw new Error('Too many waveform readings')
            readings.push(event.reading)
          }
          else result = event.result
        }
        catch {
          stop(new Error('Waveform worker emitted an invalid event'))
          return
        }
      }
      if (Buffer.byteLength(pending) > 65536) stop(new Error('Waveform event exceeds its byte bound'))
    })
    child.on('close', (code) => {
      pending += decoder.end()
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0 || !result || (options.expectedBuildHash !== undefined && result.build_hash !== options.expectedBuildHash) || pending.length || result.counts.scored_outputs !== readings.length
        || (result.raw_records === 0 && result.decoded_records > 0) || result.decoded_records < result.counts.records
        || readings.some(reading => reading.configHash !== result?.config_hashes[reading.side])) {
        reject(new Error('Waveform worker failed or returned an incomplete result'))
      }
      else resolve({ readings, run: result })
    })
    child.stdin.end(serialized)
  })
}
