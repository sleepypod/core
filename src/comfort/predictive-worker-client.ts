import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { predictiveContentHash } from './predictive-recording-store'
import { predictiveStatusRequestSchema, predictiveStatusResultSchema, predictiveWorkerRequestSchema, predictiveWorkerResultSchema,
  type PredictiveWorkerRequest } from './predictive-recording-contract'
import type { Side } from '@/src/hardware/types'
import { predictiveOutcomeRequestSchema, predictiveOutcomeResultSchema } from './predictive-outcome-contract'

interface Paths { database: string, biometrics: string }
const globals = globalThis as typeof globalThis & { __sp_predictiveChild?: symbol }

/** Installed standalone releases and local production builds use the same audited bundle. */
export function predictiveWorkerEntry(root = process.cwd()) {
  const installed = resolve(root, 'biometrics-worker/predictive-worker.cjs')
  const built = resolve(root, '.next/standalone/biometrics-worker/predictive-worker.cjs')
  return existsSync(installed) || !existsSync(built) ? installed : built
}

/** One disposable child across module instances; its lease lasts until process exit. */
function runProcess<Result>(request: unknown, parse: (input: unknown) => Result, paths: Paths, signal: AbortSignal, entry: string): Promise<Result> {
  if (signal.aborted) return Promise.reject(new Error('Prospective collection stopped.'))
  if (globals.__sp_predictiveChild) return Promise.reject(new Error('Another prospective read is running. Refresh shortly.'))
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=128', entry, resolve(paths.database), resolve(paths.biometrics)],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    const lease = Symbol('predictive-child')
    globals.__sp_predictiveChild = lease
    let output = '', failure: Error | null = null
    const fail = (error: Error) => {
      failure ??= error
      child.kill('SIGKILL')
    }
    const cancel = () => fail(new Error('Prospective collection stopped.'))
    const timer = setTimeout(() => fail(new Error('Prospective comparison exceeded ten seconds.')), 10_000)
    timer.unref()
    signal.addEventListener('abort', cancel, { once: true })
    child.once('error', () => fail(new Error('Prospective worker is unavailable.')))
    child.stdin.once('error', () => fail(new Error('Prospective worker could not receive its input.')))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (failure) return
      output += chunk
      if (Buffer.byteLength(output) > 16_384) fail(new Error('Prospective worker exceeded its result limit.'))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      if (globals.__sp_predictiveChild === lease) globals.__sp_predictiveChild = undefined
      if (failure) {
        reject(failure)
        return
      }
      try {
        if (code !== 0) throw new Error('Worker failed.')
        accept(parse(JSON.parse(output)))
      }
      catch { reject(new Error('Prospective comparison could not be verified.')) }
    })
    child.stdin.end(JSON.stringify(request))
  })
}

/** Heavy model/source reads stay off the hardware event loop. */
export function runPredictiveWorker(input: PredictiveWorkerRequest, paths: Paths, signal: AbortSignal, entry = predictiveWorkerEntry()) {
  const request = predictiveWorkerRequestSchema.parse(input)
  return runProcess(request, (value) => {
    const result = predictiveWorkerResultSchema.parse(value)
    if (result.requestHash !== predictiveContentHash(request)) throw new Error('Different observation.')
    return result
  }, paths, signal, entry)
}

/** Explicit history reads share the same process budget; they never start the collector. */
export async function readPredictiveRecordingStatus(side: Side, now: number, paths: Paths, signal: AbortSignal, entry = predictiveWorkerEntry()) {
  const request = predictiveStatusRequestSchema.parse({ version: 1, operation: 'status', side, at: now })
  const result = await runProcess(request, (value) => {
    const response = predictiveStatusResultSchema.parse(value)
    if (response.requestHash !== predictiveContentHash(request) || response.data.side !== side || response.data.generatedAt !== now) throw new Error('Different status observation.')
    return response
  }, paths, signal, entry)
  return result.data
}

/** Observed outcomes use the same bounded process and cannot apply a candidate. */
export async function readPredictiveOutcomes(side: Side, now: number, paths: Paths, signal: AbortSignal, entry = predictiveWorkerEntry()) {
  const request = predictiveOutcomeRequestSchema.parse({ version: 1, operation: 'outcomes', side, at: now })
  const result = await runProcess(request, (value) => {
    const response = predictiveOutcomeResultSchema.parse(value)
    if (response.requestHash !== predictiveContentHash(request) || response.data.side !== side || response.data.generatedAt !== now) throw new Error('Different outcome observation.')
    return response
  }, paths, signal, entry)
  return result.data
}
