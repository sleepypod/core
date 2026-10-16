import { assessEvaluation } from '../profiles/evaluation-assessment'
import { dataHash } from '../algorithms/canonical'
import { verifyReplayContext } from '../profiles/replay-context'
import { datasetManifestSchema } from './contracts'
import { installedPromotionPolicies, unqualifiedPolicies } from '../profiles/qualification-registry'
import { numericObjectivePolicies } from './contracts'
import { finalizeObjectiveReport, finalizeStageObjectiveReport } from './objective-finalization'
import { createJobOperations, type AdmissionReceipt } from './job-operations'
import type { ReplayBudget } from './execution-budget'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import type * as schema from '@/src/db/biometrics-schema'
import { DatasetStore } from './datasets'
import { BacktestJobStore } from './jobs'
import { backtestWorkSchema } from './evaluator'
import { executeWaveformInputs, verifyWaveformJobBuild } from './waveform-execution'
import type { RawInspectionLocation } from './raw-inspection-child'
import { workerBuildHash, runBacktestChild } from './child'

/** One leased attempt. Call only after the host's resource/ingest gate admits work. */
const GENERIC_FAILURE = 'Replay failed validation, resources, or execution'
/**
 * Say which step failed when the error is one of this pipeline's own fixed
 * messages; schema errors and anything that could carry data stay generic.
 */
export function failureMessage(error: unknown) {
  if (error instanceof z.ZodError) return `${GENERIC_FAILURE}: job input or report did not match its schema`
  if (error instanceof Error && /^[A-Za-z][A-Za-z ,;'()-]{2,119}$/.test(error.message)) return `${GENERIC_FAILURE}: ${error.message}`
  return GENERIC_FAILURE
}

export async function executeNextBacktest(db: BetterSQLite3Database<typeof schema>, options: {
  owner: string
  workerPath: string
  rawLocation?: RawInspectionLocation
  replayBudget?: ReplayBudget
  signal?: AbortSignal
  timeoutMs?: number
  admit: () => Promise<boolean>
  admissionReceipt?: () => AdmissionReceipt | null
}) {
  const operations = createJobOperations()
  const admit = async () => {
    const allowed = await options.admit()
    operations.record(options.admissionReceipt?.() ?? null)
    return allowed
  }
  if (options.signal?.aborted || !await admit() || options.signal?.aborted) return { state: 'deferred' as const }
  const jobs = new BacktestJobStore(db)
  const claimed = jobs.claim(options.owner)
  if (!claimed) return { state: 'idle' as const }
  const lease = { id: claimed.id, owner: options.owner, token: claimed.fencingToken }
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  let progress = z.object({ completedNights: z.number(), totalNights: z.number() }).parse(claimed.progress)
  let heartbeatFailure: unknown
  let resourceFailure = false
  let resourceCheck: Promise<void> | null = null
  const heartbeat = () => {
    try {
      const result = jobs.heartbeat(lease, { phase: 'evaluating', ...progress })
      if (result.cancelRequested) controller.abort()
    }
    catch (error) {
      heartbeatFailure = error
      controller.abort()
    }
  }
  const checkResources = async () => {
    try {
      if (await admit()) return
    }
    catch { /* Missing health evidence must stop background work. */ }
    resourceFailure = true
    controller.abort()
  }
  const timer = setInterval(() => {
    heartbeat()
    if (!resourceCheck && !controller.signal.aborted) {
      resourceCheck = checkResources().finally(() => {
        resourceCheck = null
      })
    }
  }, 5000)
  try {
    const input = z.object({ datasetId: z.string() }).parse(claimed.input)
    const retained = new DatasetStore(db).read(input.datasetId)
    const work = backtestWorkSchema.parse({ job: claimed.input, dataset: { manifest: retained.manifest, snapshot: retained.snapshot } })
    if (work.job.protocol.mode === 'signal_replay') {
      work.waveform = await executeWaveformInputs(db, work, { ...options, signal: controller.signal })
    }
    else if (await workerBuildHash(options.workerPath) !== work.job.evaluatorBuildHash) throw new Error('Evaluator bundle changed since enqueue')
    heartbeat()
    const report = await runBacktestChild(options.workerPath, work, { signal: controller.signal, timeoutMs: options.timeoutMs,
      onProgress: (completedNights, totalNights) => {
        if (totalNights !== progress.totalNights || completedNights < progress.completedNights || completedNights > totalNights) throw new Error('Invalid worker progress')
        progress = { completedNights, totalNights }
        heartbeat()
      },
    })
    if (work.job.protocol.mode === 'signal_replay') await verifyWaveformJobBuild(work, { ...options, signal: controller.signal })
    let policies = await installedPromotionPolicies(options.workerPath, { evaluatorBuildHash: work.job.evaluatorBuildHash,
      pythonBuildHash: work.job.waveform?.pythonBuildHash, protocolHash: work.job.protocolHash })
    // Quiesce the periodic check before the final fresh check and publication.
    clearInterval(timer)
    await resourceCheck
    await checkResources()
    if (heartbeatFailure) throw heartbeatFailure
    const identity = z.object({ datasetHash: z.string(), protocolHash: z.string(), evaluatorBuildHash: z.string(), split: z.string(), nights: z.array(z.unknown()) }).parse(report)
    if (identity.evaluatorBuildHash !== work.job.evaluatorBuildHash || identity.datasetHash !== work.job.datasetHash || identity.protocolHash !== work.job.protocolHash || identity.split !== work.job.split
      || identity.nights.length !== progress.totalNights || progress.completedNights !== progress.totalNights) throw new Error('Worker report identity/progress mismatch')
    if (controller.signal.aborted) throw new Error('Replay cancelled')
    const jobOperations = operations.finish()
    let qualificationWarning: string | null = null
    if (policies.protocolHash && work.job.waveform) {
      try {
        verifyReplayContext(z.object({ waveform: z.unknown() }).parse(report).waveform, {
          cohortIds: datasetManifestSchema.parse(retained.manifest).splitProtocol.assignments.filter(row => row.split === work.job.split).map(row => row.cohortId),
          configHashes: work.job.configs.map(config => config.resolvedHash), side: retained.side,
          pythonBuildHash: work.job.waveform.pythonBuildHash, otherSideConfigHash: work.job.waveform.otherSide.resolvedHash,
        }, policies.waveformContext)
      }
      catch {
        policies = unqualifiedPolicies()
        qualificationWarning = 'Replay context is outside the installed qualification; this report is descriptive.'
      }
    }
    const finalized = finalizeObjectiveReport(report, numericObjectivePolicies(work.job.protocol), jobOperations, policies.numeric)
    const measured = { ...finalizeStageObjectiveReport(finalized, work.job.protocol.stageObjectivePolicy, jobOperations, policies.stages), jobOperations, qualificationWarning }
    let status: ReturnType<typeof assessEvaluation>['status'] = 'insufficient_evidence'
    const candidate = work.job.configs.find(config => config.label === 'candidate')
    const current = work.job.configs.find(config => config.label === 'current')
    if (candidate?.revisionId && current) {
      try {
        status = assessEvaluation(work.job, { report: measured, contentHash: dataHash(measured), available: true,
          currentHoldoutUseCount: jobs.holdoutUseCount(work.job.datasetId) }, {
          side: retained.side, revisionId: candidate.revisionId, resolvedHash: candidate.resolvedHash, currentResolvedHash: current.resolvedHash,
          evaluatorBuildHash: work.job.evaluatorBuildHash, dataset: { id: retained.id, contentHash: retained.contentHash, side: retained.side,
            available: retained.available, holdoutCohortIds: datasetManifestSchema.parse(retained.manifest).splitProtocol.assignments.filter(row => row.split === 'holdout').map(row => row.cohortId) },
          ...(work.job.waveform ? { waveform: { pythonBuildHash: work.job.waveform.pythonBuildHash, otherSideConfigHash: work.job.waveform.otherSide.resolvedHash } } : {}),
        }, policies).status
      }
      catch { /* Exploratory, incomplete or incompatible evidence cannot claim improvement. */ }
    }
    if (candidate && current && candidate.resolvedHash === current.resolvedHash) status = 'no_material_change'
    jobs.complete(lease, { ...measured, status, evidence: status === 'improved' ? 'qualified_reference_agreement' : work.job.evidence })
    return { state: 'succeeded' as const, jobId: claimed.id }
  }
  catch (error) {
    // Only the authoritative lease may update state. Expired work is recovered
    // by the next claimant; it must not overwrite a replacement's result.
    try {
      const latest = jobs.get(claimed.id)
      if (latest.state === 'cancel_requested') jobs.acknowledgeCancellation(lease)
      else if (options.signal?.aborted || resourceFailure) jobs.interrupt(lease, resourceFailure ? 'Resource admission withdrawn' : 'Worker host stopped')
      else jobs.fail(lease, failureMessage(error))
    }
    catch { /* Lost lease: recovery owns the state transition. */ }
    return { state: 'stopped' as const, jobId: claimed.id }
  }
  finally {
    clearInterval(timer)
    await resourceCheck
    options.signal?.removeEventListener('abort', abort)
  }
}
