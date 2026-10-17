import type { AdmissionReceipt } from './job-operations'
import type Database from 'better-sqlite3'
import { shadowReportRequestSchema } from '../shadow/report-contracts'
import { readShadowReport } from '../shadow/report-operation'
import { referenceTraceRequestSchema } from './reference-trace-page'
import { sql } from 'drizzle-orm'
import { dirname, join } from 'node:path'
import { runRawCollectionChild } from './raw-collection-child'
import type { ReplayBudget } from './execution-budget'
import { z } from 'zod'
import { summarizeBacktestResult } from './report-summary'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '@/src/db/biometrics-schema'
import { DatasetStore, createDatasetSchema } from './datasets'
import { prepareDatasetExport } from './dataset-export'
import { BacktestJobStore, experimentProtocolSchema } from './jobs'
import { readStageTraces, readNumericTraces, readReferenceTraces } from './traces'
import { traceRequestSchema } from './trace-contracts'
import { executeNextBacktest } from './runner'

import { RawSourceCatalog, rawSourcePageSchema } from './raw-catalog'
import { rawScanInputSchema, runRawInspectionChild, podRawInspectionLocation, type RawInspectionLocation } from './raw-inspection-child'

import { createWaveformDatasetSchema } from './waveform-selection'
import { publishSelectedWaveformDataset } from './waveform-publication'

const idInput = z.object({ id: z.string().uuid() }).strict()
export const coordinatorTaskSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('readShadowReport'), input: shadowReportRequestSchema }).strict(),
  z.object({ type: z.literal('createWaveformDataset'), input: createWaveformDatasetSchema }).strict(),
  z.object({ type: z.literal('inspectRawSource'), input: rawScanInputSchema }).strict(),
  z.object({ type: z.literal('pageRawSources'), input: rawSourcePageSchema }).strict(),
  z.object({ type: z.literal('createDataset'), input: createDatasetSchema }).strict(),
  z.object({ type: z.literal('datasetDescriptor'), input: idInput }).strict(),
  z.object({ type: z.literal('exportDataset'), input: idInput }).strict(),
  z.object({ type: z.literal('readResult'), input: idInput }).strict(),
  z.object({ type: z.literal('readSummary'), input: idInput }).strict(),
  z.object({ type: z.literal('readReferenceTrace'), input: referenceTraceRequestSchema }).strict(),
  z.object({ type: z.literal('readNumericTrace'), input: traceRequestSchema }).strict(),
  z.object({ type: z.literal('readTrace'), input: traceRequestSchema }).strict(),
  z.object({ type: z.literal('releaseDataset'), input: idInput }).strict(),
  z.object({ type: z.literal('releaseResult'), input: idInput.extend({ expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/) }) }).strict(),
  z.object({ type: z.literal('createExperiment'), input: z.object({ datasetId: z.string().uuid(), protocol: experimentProtocolSchema, idempotencyKey: z.string().min(1).max(200) }).strict() }).strict(),
  z.object({ type: z.literal('collectArtifacts') }).strict(),
  z.object({ type: z.literal('execute'), owner: z.string().min(1).max(200) }).strict(),
])
export type CoordinatorTask = z.input<typeof coordinatorTaskSchema>
export interface CoordinatorResults {
  readShadowReport: ReturnType<typeof readShadowReport>
  createWaveformDataset: Awaited<ReturnType<typeof publishSelectedWaveformDataset>>
  inspectRawSource: Awaited<ReturnType<typeof inspectRawSource>>
  pageRawSources: ReturnType<RawSourceCatalog['page']>
  createDataset: ReturnType<DatasetStore['create']>
  datasetDescriptor: ReturnType<DatasetStore['descriptor']>
  exportDataset: Awaited<ReturnType<typeof prepareDatasetExport>>
  readResult: ReturnType<BacktestJobStore['result']>
  readSummary: ReturnType<typeof summarizeBacktestResult<NonNullable<ReturnType<BacktestJobStore['result']>>>>
  readReferenceTrace: ReturnType<typeof readReferenceTraces>
  readNumericTrace: ReturnType<typeof readNumericTraces>
  readTrace: ReturnType<typeof readStageTraces>
  releaseDataset: ReturnType<DatasetStore['release']>
  releaseResult: ReturnType<BacktestJobStore['releaseResult']>
  createExperiment: ReturnType<BacktestJobStore['createExperiment']>
  collectArtifacts: null
  execute: Awaited<ReturnType<typeof executeNextBacktest>>
}

/** Fixed shipped operations; neither executable code nor paths come from RPC input. */
export async function performCoordinatorTask(db: BetterSQLite3Database<typeof schema> & { $client: Database.Database }, raw: unknown, options: {
  workerPath: string
  rawLocation?: RawInspectionLocation
  replayBudget?: ReplayBudget
  signal: AbortSignal
  admit: () => Promise<boolean>
  admissionReceipt?: () => AdmissionReceipt | null
}) {
  const task = coordinatorTaskSchema.parse(raw)
  switch (task.type) {
    case 'readShadowReport': return readShadowReport(db.$client, task.input)
    case 'createWaveformDataset': return publishSelectedWaveformDataset(db, task.input, options)
    case 'inspectRawSource': return inspectRawSource(db, task.input, options)
    case 'pageRawSources': return new RawSourceCatalog(db).page(task.input)
    case 'createDataset': return new DatasetStore(db).create(task.input)
    case 'datasetDescriptor': return new DatasetStore(db).descriptor(task.input.id)
    case 'exportDataset': return prepareDatasetExport(db, task.input.id)
    case 'readResult': return new BacktestJobStore(db).result(task.input.id)
    case 'readSummary': return summarizeBacktestResult(new BacktestJobStore(db).result(task.input.id))
    case 'readReferenceTrace': return readReferenceTraces(db, task.input)
    case 'readNumericTrace': return readNumericTraces(db, task.input)
    case 'readTrace': return readStageTraces(db, task.input)
    case 'releaseDataset': return new DatasetStore(db).release(task.input.id)
    case 'releaseResult': return new BacktestJobStore(db).releaseResult(task.input.id, task.input.expectedContentHash)
    case 'createExperiment': return new BacktestJobStore(db).createExperiment(task.input.datasetId, task.input.protocol, task.input.idempotencyKey)
    case 'collectArtifacts':
      new BacktestJobStore(db).collectOrphanedArtifacts()
      await collectRawArtifacts(db, options)
      return null
    case 'execute': return executeNextBacktest(db, { owner: task.owner, ...options })
  }
}

/** Recheck resource health during decompression and before committing evidence. */
async function inspectRawSource(db: BetterSQLite3Database<typeof schema>, input: z.input<typeof rawScanInputSchema>, options: {
  signal: AbortSignal
  admit: () => Promise<boolean>
  rawLocation?: RawInspectionLocation
  replayBudget?: ReplayBudget
}) {
  const deferred = { status: 'deferred' as const, nextCursor: input.afterName }
  if (options.signal.aborted || !await options.admit()) return deferred
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal.addEventListener('abort', abort, { once: true })
  if (options.signal.aborted) abort()
  let checking: Promise<void> | undefined, denied = false
  const timer = setInterval(() => {
    if (checking) return
    checking = Promise.resolve().then(() => options.admit()).catch(() => false).then((allowed) => {
      if (!allowed) {
        denied = true
        controller.abort()
      }
    }).finally(() => { checking = undefined })
  }, 5000)
  try {
    const result = await runRawInspectionChild(options.rawLocation ?? podRawInspectionLocation, input, { signal: controller.signal })
    clearInterval(timer)
    await checking
    if (denied || options.signal.aborted || !await options.admit() || options.signal.aborted) return deferred
    if (result.status !== 'inspected') return result
    const id = new RawSourceCatalog(db).record(result.inspection)
    return { status: 'inspected' as const, nextCursor: result.nextCursor, source: new RawSourceCatalog(db).read(id) }
  }
  catch (error) {
    if (denied) return deferred
    throw error
  }
  finally {
    clearInterval(timer)
    await checking
    options.signal.removeEventListener('abort', abort)
  }
}

/** Same work lane as publication; Python additionally locks across processes. */
async function collectRawArtifacts(db: BetterSQLite3Database<typeof schema>, options: {
  signal: AbortSignal
  admit: () => Promise<boolean>
  rawLocation?: RawInspectionLocation
}) {
  if (options.signal.aborted || !await options.admit()) return
  const databasePath = db.all<{ name: string, file: string }>(sql`PRAGMA database_list`).find(row => row.name === 'main')?.file
  if (!databasePath) return
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal.addEventListener('abort', abort, { once: true })
  if (options.signal.aborted) abort()
  let checking: Promise<void> | undefined
  const timer = setInterval(() => {
    if (checking) return
    checking = Promise.resolve().then(options.admit).catch(() => false).then((allowed) => {
      if (!allowed) controller.abort()
    }).finally(() => { checking = undefined })
  }, 5000)
  try {
    await runRawCollectionChild({ ...(options.rawLocation ?? podRawInspectionLocation), databasePath,
      retainedDirectory: join(dirname(databasePath), 'biometric-raw') }, { signal: controller.signal })
  }
  finally {
    clearInterval(timer)
    await checking
    options.signal.removeEventListener('abort', abort)
  }
}
