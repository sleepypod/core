import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { migratedComfortDatabase } from './databaseFixture'
import { predictiveRecordingFixture } from './predictiveRecordingFixture'
import { predictiveWorkerEntry, readPredictiveRecordingStatus, readPredictiveOutcomes, runPredictiveWorker } from '../predictive-worker-client'
import { createPredictiveRecordings, predictiveContentHash } from '../predictive-recording-store'
import { evaluatePredictiveRecording } from '../predictive-worker'

let directory: string
let bundleDirectory: string
beforeAll(() => {
  mkdirSync('node_modules/.cache', { recursive: true })
  bundleDirectory = mkdtempSync(resolve('node_modules/.cache/predictive-test-'))
  execFileSync(process.execPath, ['scripts/build/biometrics-worker.mjs', bundleDirectory], { timeout: 20_000 })
})
afterAll(() => {
  if (bundleDirectory) rmSync(bundleDirectory, { recursive: true, force: true })
})
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sleepypod-predictive-worker-'))
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))
function files() {
  const database = join(directory, 'sleepypod.db'), biometrics = join(directory, 'biometrics.db')
  migratedComfortDatabase(database).close()
  new Database(biometrics).close()
  return { database, biometrics }
}
function script(source: string) {
  const entry = join(directory, 'worker.cjs')
  // Match the real worker protocol: consume the request before replying.
  // Exiting before stdin drains races EPIPE against response validation.
  writeFileSync(entry, `process.stdin.resume(); process.stdin.once('end', () => { ${source} });`)
  return entry
}
describe('bounded read-only research process', () => {
  it('resolves the audited standalone bundle in an installed release or local production build', () => {
    const built = join(directory, '.next/standalone/biometrics-worker')
    const installed = join(directory, 'biometrics-worker')
    mkdirSync(built, { recursive: true })
    writeFileSync(join(built, 'predictive-worker.cjs'), '')
    expect(predictiveWorkerEntry(directory)).toBe(join(built, 'predictive-worker.cjs'))
    mkdirSync(installed)
    writeFileSync(join(installed, 'predictive-worker.cjs'), '')
    expect(predictiveWorkerEntry(directory)).toBe(join(installed, 'predictive-worker.cjs'))
  })
  it('inspects retained history in the packaged child without changing either database', async () => {
    const paths = files(), { record } = predictiveRecordingFixture(), now = record.recordedAt
    const database = new Database(paths.database)
    createPredictiveRecordings(database).append(record, now)
    database.close()
    const filenames = [paths.database, paths.biometrics]
    const before = filenames.map(filename => readFileSync(filename))
    // Native equality still checks every byte without deep-walking SQLite files.
    const expectUnchangedFiles = () => filenames.forEach((filename, index) => {
      expect(readFileSync(filename).equals(before[index])).toBe(true)
    })
    const result = await readPredictiveRecordingStatus('left', now, paths, new AbortController().signal,
      join(bundleDirectory, 'predictive-worker.cjs'))
    expect(result).toMatchObject({ side: 'left', generatedAt: now, records: 1, sessions: 1, candidates: 1, activationAvailable: false })
    expectUnchangedFiles()
    const outcomes = await readPredictiveOutcomes('left', now, paths, new AbortController().signal,
      join(bundleDirectory, 'predictive-worker.cjs'))
    expect(outcomes).toMatchObject({ considered: 1, pending: 1, scored: 0, activationAvailable: false })
    expectUnchangedFiles()
    // Each real child retains its 10-second deadline. This harness runs two
    // reads plus database setup and coverage instrumentation on shared hosts.
  }, 25_000)
  it.each(['request hash', 'side', 'time', 'future record'] as const)('rejects a status result with mismatched %s', async (kind) => {
    const paths = files(), { record } = predictiveRecordingFixture(), now = record.recordedAt
    const database = new Database(paths.database)
    createPredictiveRecordings(database).append(record, now)
    const data = createPredictiveRecordings(database).status('left', now)
    database.close()
    const result = { version: 1, requestHash: predictiveContentHash({ version: 1, operation: 'status', side: 'left', at: now }), data }
    if (kind === 'request hash') result.requestHash = 'f'.repeat(64)
    if (kind === 'side') result.data.side = 'right'
    if (kind === 'time') result.data.generatedAt++
    if (kind === 'future record') result.data.latestAt = now + 1
    await expect(readPredictiveRecordingStatus('left', now, paths, new AbortController().signal,
      script(`process.stdout.write(${JSON.stringify(JSON.stringify(result))})`))).rejects.toThrow('verified')
  })
  it('shares one process budget across history and model reads and releases it after cancellation', async () => {
    const paths = files(), { observation } = predictiveRecordingFixture(), abort = new AbortController()
    const pending = runPredictiveWorker(observation.request, paths, abort.signal, script('setInterval(() => {}, 1000)'))
    await expect(readPredictiveRecordingStatus('left', observation.request.at, paths, new AbortController().signal,
      join(bundleDirectory, 'predictive-worker.cjs'))).rejects.toThrow('Another prospective read')
    abort.abort()
    await expect(pending).rejects.toThrow('stopped')
    await expect(readPredictiveRecordingStatus('left', observation.request.at, paths, new AbortController().signal,
      join(bundleDirectory, 'predictive-worker.cjs'))).resolves.toMatchObject({ records: 0 })
  })
  it('reads the actual packaged worker without starting a device or fitting a model', async () => {
    const paths = files(), { observation } = predictiveRecordingFixture()
    const result = await runPredictiveWorker(observation.request, paths, new AbortController().signal,
      join(bundleDirectory, 'predictive-worker.cjs'))
    expect(result).toMatchObject({ holdIdentity: null, responseIdentity: null, hold: { predictions: [] } })
    const database = new Database(paths.database, { readonly: true })
    for (const table of ['comfort_states', 'predictive_recordings', 'temperature_applications', 'thermal_forecasts', 'target_response_models']) {
      expect(database.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
    }
    database.close()
  })
  it('refuses a writable SQLite handle', () => {
    const paths = files(), database = new Database(paths.database), biometrics = new Database(paths.biometrics, { readonly: true })
    try {
      expect(() => evaluatePredictiveRecording(database, biometrics, predictiveRecordingFixture().observation.request)).toThrow('read-only')
    }
    finally {
      database.close()
      biometrics.close()
    }
  })
  it.each(['malformed', 'wrong request', 'oversized', 'exit', 'missing'] as const)('rejects %s worker output', async (kind) => {
    const { observation, forecasts } = predictiveRecordingFixture(), paths = files()
    forecasts.requestHash = 'f'.repeat(64)
    const source = kind === 'oversized'
      ? 'process.stdout.write(\'x\'.repeat(17000))'
      : kind === 'malformed'
        ? 'process.stdout.write(\'not json\')'
        : kind === 'exit' ? 'process.exit(1)' : `process.stdout.write(${JSON.stringify(JSON.stringify(forecasts))})`
    const entry = kind === 'missing' ? join(directory, 'absent.cjs') : script(source)
    await expect(runPredictiveWorker(observation.request, paths, new AbortController().signal, entry)).rejects.toThrow()
  })
  it('kills work when the controller stops and rejects an already cancelled request', async () => {
    const paths = files(), { observation } = predictiveRecordingFixture(), abort = new AbortController()
    const pending = runPredictiveWorker(observation.request, paths, abort.signal, script('setInterval(() => {}, 1000)'))
    abort.abort()
    await expect(pending).rejects.toThrow('stopped')
    await expect(runPredictiveWorker(observation.request, paths, abort.signal)).rejects.toThrow('stopped')
  })
  it('bounds a stalled child to ten seconds', async () => {
    const paths = files(), { observation } = predictiveRecordingFixture()
    await expect(runPredictiveWorker(observation.request, paths, new AbortController().signal,
      script('setInterval(() => {}, 1000)'))).rejects.toThrow('ten seconds')
  }, 15_000)
  it('packages no live hardware, streaming or database initializer', () => {
    const imports = JSON.parse(readFileSync(join(bundleDirectory, 'predictive-dependencies.json'), 'utf8')) as string[]
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.filter(path => /src\/(hardware|automation|scheduler|homekit|streaming)\//.test(path)
      || /src\/db\/(index|biometrics)\.ts$/.test(path))).toEqual([])
  })
})
