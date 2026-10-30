import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { and, asc, desc, eq, gt, inArray, lt, lte, or, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as schema from '@/src/db/biometrics-schema'
import { configHash, dataHash } from '../algorithms/canonical'
import { manifestHash, validateConfig } from '../algorithms/registry'
import { ReferenceInputError } from '../references/time'
import { DatasetStore } from './datasets'
import { MAX_REPORT_BYTES, REPORT_BUDGET_BYTES, ReportArtifactStore, reportArtifactSchema } from './artifacts'

const jobs = schema.biometricBacktestJobs
const experiments = schema.biometricExperiments
const results = schema.biometricBacktestResults
const exposure = schema.biometricHoldoutAccesses
const manifestSchema = z.object({ splitProtocol: z.object({ assignments: z.array(z.object({ split: z.string(), startMs: z.number(), endMs: z.number() })) }) })
const key = z.string().min(1).max(200)
export { experimentProtocolSchema, enqueueBacktestSchema } from './contracts'
import { experimentProtocolSchema, enqueueBacktestSchema } from './contracts'
const progressSchema = z.object({ phase: z.enum(['queued', 'loading', 'evaluating', 'reporting', 'complete']),
  completedNights: z.number().int().min(0).max(60), totalNights: z.number().int().min(0).max(60) }).strict()
const leaseSchema = z.object({ id: z.string().uuid(), owner: key, token: z.number().int().positive() }).strict()
export type JobLease = z.infer<typeof leaseSchema>

/** Leases fence every publication; all expensive work happens outside SQLite. */
export class BacktestJobStore {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>, private readonly now = Date.now,
    private readonly artifactStore?: ReportArtifactStore) {}

  private storage() {
    if (this.artifactStore) return this.artifactStore
    const main = this.db.all<{ name: string, file: string }>(sql`PRAGMA database_list`).find(row => row.name === 'main')
    return main?.file ? new ReportArtifactStore(join(dirname(main.file), 'biometric-report-artifacts')) : undefined
  }

  private artifacts() {
    const store = this.storage()
    if (!store) throw new ReferenceInputError('RESOURCE_LIMIT', 'Large reports require a persistent artifact directory')
    return store
  }

  collectOrphanedArtifacts() {
    const store = this.artifacts()
    return store.withPublication(() => {
      const referenced = new Set(this.db.select({ report: results.report }).from(results).all().flatMap((row) => {
        // Preserve named future-version descriptors during downgrade.
        const artifact = z.object({ name: z.string() }).safeParse(row.report)
        return artifact.success ? [artifact.data.name] : []
      }))
      return store.collect(referenced, this.now())
    })
  }

  createExperiment(datasetId: string, rawProtocol: z.input<typeof experimentProtocolSchema>, idempotencyKey: string = randomUUID()) {
    const protocol = experimentProtocolSchema.parse(rawProtocol)
    if (protocol.waveformStages === undefined) delete protocol.waveformStages
    key.parse(idempotencyKey)
    const requestHash = configHash({ datasetId, protocol })
    return this.db.transaction((tx) => {
      const existing = tx.select().from(experiments).where(eq(experiments.idempotencyKey, idempotencyKey)).get()
      if (existing) {
        if (existing.requestHash !== requestHash) throw new ReferenceInputError('REVISION_CONFLICT', 'Experiment idempotency key changed')
        return existing
      }
      // Recover a committed request before reading inputs that the owner may
      // since have released. New experiments still require verified retention.
      const dataset = new DatasetStore(tx).read(datasetId)
      if (protocol.mode === 'signal_replay' && dataset.snapshot.version !== 'waveform-dataset-v1') throw new ReferenceInputError('INSUFFICIENT_RAW_DATA', 'Signal replay requires retained waveform inputs')
      const total = tx.select({ count: sql<number>`count(*)` }).from(experiments).get()?.count ?? 0
      if (total >= 1000) throw new ReferenceInputError('RESOURCE_LIMIT', 'Experiment history has reached its 1000-entry bound')
      return tx.insert(experiments).values({ id: randomUUID(), datasetId, idempotencyKey, requestHash, side: dataset.side,
        protocol, protocolHash: configHash(protocol), createdAtMs: this.now() }).returning().get()
    }, { behavior: 'immediate' })
  }

  getExperiment(id: string) {
    const experiment = this.db.select().from(experiments).where(eq(experiments.id, id)).get()
    if (!experiment) throw new ReferenceInputError('NOT_FOUND', 'Experiment not found')
    return { ...experiment, protocol: experimentProtocolSchema.parse(experiment.protocol) }
  }

  pageExperiments(side: 'left' | 'right', cursor?: { createdAtMs: number, id: string }) {
    const rows = this.db.select().from(experiments).where(and(eq(experiments.side, side), cursor
      ? or(lt(experiments.createdAtMs, cursor.createdAtMs), and(eq(experiments.createdAtMs, cursor.createdAtMs), lt(experiments.id, cursor.id)))
      : undefined))
      .orderBy(desc(experiments.createdAtMs), desc(experiments.id)).limit(51).all()
    const items = rows.slice(0, 50).map(row => ({ ...row, protocol: experimentProtocolSchema.parse(row.protocol) }))
    const last = items.at(-1)
    return { items, nextCursor: rows.length > 50 && last ? { createdAtMs: last.createdAtMs, id: last.id } : null }
  }

  holdoutUseCount(datasetId: string) {
    const dataset = this.db.select({ side: schema.biometricDatasets.side, manifest: schema.biometricDatasets.manifest })
      .from(schema.biometricDatasets).where(eq(schema.biometricDatasets.id, datasetId)).get()
    if (!dataset) throw new ReferenceInputError('NOT_FOUND', 'Dataset unavailable')
    const windows = manifestSchema.parse(dataset.manifest).splitProtocol.assignments.filter(row => row.split === 'holdout')
    if (!windows.length) return 0
    return this.db.selectDistinct({ jobId: exposure.jobId }).from(exposure).where(and(eq(exposure.side, dataset.side),
      or(...windows.map(window => and(lt(exposure.startMs, window.endMs), gt(exposure.endMs, window.startMs)))),
    )).all().length
  }

  enqueue(raw: z.input<typeof enqueueBacktestSchema>) {
    const input = enqueueBacktestSchema.parse(raw)
    if (input.waveform === undefined) delete input.waveform
    if (new Set(input.configs.map(config => config.label)).size !== input.configs.length) throw new ReferenceInputError('INVALID_CONFIG', 'Baseline labels must be unique')
    for (const config of input.configs) {
      const resolved = validateConfig(config.resolved)
      if (config.manifestHash !== manifestHash || configHash(resolved) !== config.resolvedHash) throw new ReferenceInputError('INVALID_CONFIG', 'Resolved config or engine hash does not match this build')
    }
    if (Buffer.byteLength(JSON.stringify(input)) > 64 * 1024) throw new ReferenceInputError('RESOURCE_LIMIT', 'Backtest configuration snapshot exceeds 64 KiB')
    const requestHash = configHash(input)
    return this.db.transaction((tx) => {
      const existing = tx.select().from(jobs).where(eq(jobs.idempotencyKey, input.idempotencyKey)).get()
      if (existing) {
        if (existing.requestHash !== requestHash) throw new ReferenceInputError('REVISION_CONFLICT', 'Backtest idempotency key changed')
        return existing
      }
      const total = tx.select({ count: sql<number>`count(*)` }).from(jobs).get()?.count ?? 0
      if (total >= 1000) throw new ReferenceInputError('RESOURCE_LIMIT', 'Job history has reached its 1000-entry bound')
      const experiment = tx.select().from(experiments).where(eq(experiments.id, input.experimentId)).get()
      if (!experiment) throw new ReferenceInputError('NOT_FOUND', 'Experiment not found')
      const protocol = experimentProtocolSchema.parse(experiment.protocol)
      if ((protocol.mode === 'signal_replay') !== Boolean(input.waveform)) throw new ReferenceInputError('INVALID_CONFIG', 'Waveform replay requires pinned Python and other-side configuration')
      if (input.waveform && (input.waveform.otherSide.manifestHash !== manifestHash
        || configHash(validateConfig(input.waveform.otherSide.resolved)) !== input.waveform.otherSide.resolvedHash)) throw new ReferenceInputError('INVALID_CONFIG', 'Other-side configuration identity mismatch')
      const dataset = tx.select({ contentHash: schema.biometricDatasets.contentHash, releasedAtMs: schema.biometricDatasets.releasedAtMs, manifest: schema.biometricDatasets.manifest })
        .from(schema.biometricDatasets).where(eq(schema.biometricDatasets.id, experiment.datasetId)).get()
      if (!dataset) throw new ReferenceInputError('NOT_FOUND', 'Dataset unavailable')
      if (dataset.releasedAtMs !== null) throw new ReferenceInputError('DATASET_RELEASED', 'Retained dataset inputs were explicitly released')
      const manifest = manifestSchema.parse(dataset.manifest)
      const totalNights = manifest.splitProtocol.assignments.filter(group => group.split === input.split).length
      if (!totalNights) throw new ReferenceInputError('INSUFFICIENT_NIGHTS', 'The frozen dataset has no nights assigned to this split')
      let holdoutUse = this.holdoutUseCount(experiment.datasetId)
      if (input.split === 'holdout') {
        holdoutUse++
        tx.update(experiments).set({ holdoutAccesses: experiment.holdoutAccesses + 1 }).where(eq(experiments.id, experiment.id)).run()
      }
      const now = this.now()
      const job = tx.insert(jobs).values({ id: randomUUID(), experimentId: experiment.id, idempotencyKey: input.idempotencyKey, requestHash,
        input: { version: 'backtest-job-v1', ...input, datasetId: experiment.datasetId, datasetHash: dataset.contentHash,
          protocol: experiment.protocol, protocolHash: experiment.protocolHash, holdoutUse,
          evidence: input.split === 'holdout' && holdoutUse > 1 ? 'reused_holdout_is_validation' : 'descriptive_only' },
        state: 'queued', progress: { phase: 'queued', completedNights: 0, totalNights }, createdAtMs: now, updatedAtMs: now,
      }).returning().get()
      if (input.split === 'holdout') {
        for (const window of manifest.splitProtocol.assignments.filter(row => row.split === 'holdout')) {
          tx.insert(exposure).values({ id: randomUUID(), jobId: job.id, side: experiment.side, startMs: window.startMs, endMs: window.endMs, accessedAtMs: now }).run()
        }
      }
      return job
    }, { behavior: 'immediate' })
  }

  page(side: 'left' | 'right', cursor?: { createdAtMs: number, id: string }) {
    const rows = this.db.select({ job: jobs }).from(jobs).innerJoin(experiments, eq(jobs.experimentId, experiments.id))
      .where(and(eq(experiments.side, side), cursor
        ? or(lt(jobs.createdAtMs, cursor.createdAtMs), and(eq(jobs.createdAtMs, cursor.createdAtMs), lt(jobs.id, cursor.id)))
        : undefined))
      .orderBy(desc(jobs.createdAtMs), desc(jobs.id)).limit(51).all().map(row => row.job)
    const items = rows.slice(0, 50)
    const last = items.at(-1)
    return { items, nextCursor: rows.length > 50 && last ? { createdAtMs: last.createdAtMs, id: last.id } : null }
  }

  get(id: string) {
    const job = this.db.select().from(jobs).where(eq(jobs.id, id)).get()
    if (!job) throw new ReferenceInputError('NOT_FOUND', 'Backtest job not found')
    return job
  }

  result(id: string) {
    const storage = this.storage()
    const read = () => {
      const job = this.get(id)
      if (job.state !== 'succeeded') return null
      const result = this.db.select().from(results).where(eq(results.jobId, id)).get()
      if (!result || result.fencingToken !== job.fencingToken) throw new ReferenceInputError('RESULT_CORRUPT', 'Backtest result integrity check failed')
      const input = z.object({ datasetId: z.string() }).parse(job.input)
      const currentHoldoutUseCount = this.holdoutUseCount(input.datasetId)
      if (result.releasedAtMs !== null) return { ...result, report: null, available: false, currentHoldoutUseCount }
      const artifact = reportArtifactSchema.safeParse(result.report)
      const report = artifact.success ? this.artifacts().read(artifact.data) : result.report
      if (dataHash(report) !== result.contentHash) throw new ReferenceInputError('RESULT_CORRUPT', 'Backtest result integrity check failed')
      return { ...result, report, available: true, currentHoldoutUseCount }
    }
    // A release cannot unlink an artifact between reading its descriptor and bytes.
    return storage ? storage.withPublication(read) : read()
  }

  /** Release payload bytes, retaining winning-attempt and holdout audit records.
   * The caller must identify the exact report hash it intends to release. */
  releaseResult(id: string, expectedContentHash: string) {
    z.string().regex(/^[a-f0-9]{64}$/).parse(expectedContentHash)
    const storage = this.storage()
    const release = () => {
      const previous = this.db.transaction((tx) => {
        const job = this.get(id)
        if (job.state !== 'succeeded') throw new ReferenceInputError('INVALID_STATE', 'Only completed reports can be released')
        const result = tx.select().from(results).where(eq(results.jobId, id)).get()
        if (!result || result.fencingToken !== job.fencingToken) throw new ReferenceInputError('RESULT_CORRUPT', 'Backtest result integrity check failed')
        if (result.contentHash !== expectedContentHash) throw new ReferenceInputError('REVISION_CONFLICT', 'Report hash changed')
        if (result.releasedAtMs === null) {
          tx.update(results).set({ report: {}, releasedAtMs: this.now() }).where(eq(results.jobId, id)).run()
        }
        return result.report
      }, { behavior: 'immediate' })
      const artifact = reportArtifactSchema.safeParse(previous)
      if (artifact.success && storage) {
        const stillReferenced = this.db.select({ report: results.report }).from(results).all().some((row) => {
          const named = z.object({ name: z.string() }).safeParse(row.report)
          return named.success && named.data.name === artifact.data.name
        })
        if (!stillReferenced) storage.removeReleased(artifact.data)
      }
    }
    if (storage) storage.withPublication(release)
    else release()
    return this.result(id)
  }

  /** Recover expired attempts without granting stale owners publication rights. */
  recover() {
    const now = this.now()
    return this.db.transaction((tx) => {
      const expired = tx.select().from(jobs).where(and(inArray(jobs.state, ['running', 'cancel_requested']), lte(jobs.leaseExpiresAtMs, now))).all()
      for (const job of expired) {
        tx.update(jobs).set({ state: job.state === 'cancel_requested' ? 'cancelled' : job.attempt >= 3 ? 'failed' : 'interrupted',
          leaseOwner: null, leaseExpiresAtMs: null, error: job.state === 'cancel_requested' ? null : 'Worker lease expired', updatedAtMs: now,
        }).where(eq(jobs.id, job.id)).run()
      }
      return expired.length
    }, { behavior: 'immediate' })
  }

  claim(owner: string, leaseMs = 30000) {
    key.parse(owner)
    z.number().int().min(1000).max(120000).parse(leaseMs)
    this.recover()
    return this.db.transaction((tx) => {
      const now = this.now()
      const active = tx.select({ id: jobs.id }).from(jobs).where(and(inArray(jobs.state, ['running', 'cancel_requested']), gt(jobs.leaseExpiresAtMs, now))).get()
      if (active) return null // one background replay at a time across processes
      const job = tx.select().from(jobs).where(inArray(jobs.state, ['queued', 'interrupted'])).orderBy(asc(jobs.createdAtMs), asc(jobs.id)).get()
      if (!job) return null
      return tx.update(jobs).set({ state: 'running', leaseOwner: owner, leaseExpiresAtMs: now + leaseMs,
        heartbeatAtMs: now, fencingToken: job.fencingToken + 1, attempt: job.attempt + 1,
        progress: { ...progressSchema.parse(job.progress), phase: 'loading', completedNights: 0 }, error: null, updatedAtMs: now,
      }).where(eq(jobs.id, job.id)).returning().get()
    }, { behavior: 'immediate' })
  }

  private owned(lease: JobLease) {
    leaseSchema.parse(lease)
    const job = this.get(lease.id)
    if (job.leaseOwner !== lease.owner || job.fencingToken !== lease.token || (job.leaseExpiresAtMs ?? 0) <= this.now()
      || !['running', 'cancel_requested'].includes(job.state)) throw new ReferenceInputError('STALE_LEASE', 'Worker lease is no longer authoritative')
    return job
  }

  heartbeat(lease: JobLease, rawProgress: z.input<typeof progressSchema>, leaseMs = 30000) {
    const progress = progressSchema.parse(rawProgress)
    z.number().int().min(1000).max(120000).parse(leaseMs)
    return this.db.transaction((tx) => {
      const job = this.owned(lease)
      const previous = progressSchema.parse(job.progress)
      if (progress.totalNights !== previous.totalNights || progress.completedNights < previous.completedNights || progress.completedNights > progress.totalNights) throw new ReferenceInputError('INVALID_PROGRESS', 'Progress must be monotonic within the frozen night count')
      const now = this.now()
      tx.update(jobs).set({ progress, heartbeatAtMs: now, leaseExpiresAtMs: now + leaseMs, updatedAtMs: now }).where(eq(jobs.id, job.id)).run()
      return { cancelRequested: job.state === 'cancel_requested' }
    }, { behavior: 'immediate' })
  }

  cancel(id: string) {
    return this.db.transaction((tx) => {
      const job = this.get(id)
      if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return job
      const now = this.now()
      return tx.update(jobs).set({ state: job.state === 'queued' || job.state === 'interrupted' ? 'cancelled' : 'cancel_requested',
        cancellationRequestedAtMs: job.cancellationRequestedAtMs ?? now, updatedAtMs: now }).where(eq(jobs.id, id)).returning().get()
    }, { behavior: 'immediate' })
  }

  acknowledgeCancellation(lease: JobLease) {
    return this.db.transaction((tx) => {
      const job = this.owned(lease)
      if (job.state !== 'cancel_requested') throw new ReferenceInputError('INVALID_STATE', 'Cancellation has not been requested')
      return tx.update(jobs).set({ state: 'cancelled', leaseOwner: null, leaseExpiresAtMs: null, updatedAtMs: this.now() }).where(eq(jobs.id, job.id)).returning().get()
    }, { behavior: 'immediate' })
  }

  interrupt(lease: JobLease, reason: 'Worker host stopped' | 'Resource admission withdrawn' = 'Worker host stopped') {
    return this.db.transaction((tx) => {
      const job = this.owned(lease)
      return tx.update(jobs).set({ state: job.state === 'cancel_requested' ? 'cancelled' : job.attempt >= 3 ? 'failed' : 'interrupted',
        error: reason, leaseOwner: null, leaseExpiresAtMs: null, updatedAtMs: this.now() }).where(eq(jobs.id, job.id)).returning().get()
    }, { behavior: 'immediate' })
  }

  fail(lease: JobLease, message: string) {
    return this.db.transaction((tx) => {
      const job = this.owned(lease)
      return tx.update(jobs).set({ state: job.state === 'cancel_requested' ? 'cancelled' : 'failed',
        error: message.slice(0, 1000), leaseOwner: null, leaseExpiresAtMs: null, updatedAtMs: this.now() }).where(eq(jobs.id, job.id)).returning().get()
    }, { behavior: 'immediate' })
  }

  complete(lease: JobLease, report: unknown) {
    // Concrete evaluator schemas validate reports before calling this sink.
    const serialized = JSON.stringify(report)
    if (!serialized || Buffer.byteLength(serialized) > MAX_REPORT_BYTES) throw new ReferenceInputError('RESOURCE_LIMIT', 'Backtest report exceeds 16 MiB')
    const contentHash = dataHash(report)
    const artifacts = this.storage()
    const publish = () => {
      const owned = this.owned(lease)
      if (owned.state !== 'running') throw new ReferenceInputError('INVALID_STATE', 'Cancelled work cannot publish a result')
      let stored: unknown = report
      const inlineBytes = this.db.select({ bytes: sql<number>`coalesce(sum(case when json_extract(${results.report}, '$.kind') = 'biometric-report-artifact-v1' then 0 else length(cast(${results.report} as blob)) end), 0)` }).from(results).get()?.bytes ?? 0
      if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) {
        if (!artifacts) throw new ReferenceInputError('RESOURCE_LIMIT', 'Large reports require a persistent artifact directory')
        stored = artifacts.write(lease.id, lease.token, serialized, inlineBytes)
      }
      else if (inlineBytes + (artifacts?.usage() ?? 0) + Buffer.byteLength(serialized) > REPORT_BUDGET_BYTES) {
        throw new ReferenceInputError('RESOURCE_LIMIT', 'Reports and staged artifacts reached the 64 MiB storage budget')
      }
      return this.db.transaction((tx) => {
        const job = this.owned(lease)
        if (job.state !== 'running') throw new ReferenceInputError('INVALID_STATE', 'Cancelled work cannot publish a result')
        const retained = tx.select({ bytes: sql<number>`coalesce(sum(case when json_extract(${results.report}, '$.kind') = 'biometric-report-artifact-v1' then json_extract(${results.report}, '$.byteLength') else length(cast(${results.report} as blob)) end), 0)` }).from(results).get()?.bytes ?? 0
        if (retained + Buffer.byteLength(serialized) > REPORT_BUDGET_BYTES) throw new ReferenceInputError('RESOURCE_LIMIT', 'Backtest summaries have reached their 64 MiB storage budget')
        const now = this.now()
        tx.insert(results).values({ jobId: job.id, fencingToken: lease.token, report: stored, contentHash, completedAtMs: now }).run()
        const progress = progressSchema.parse(job.progress)
        tx.update(jobs).set({ state: 'succeeded', progress: { ...progress, phase: 'complete', completedNights: progress.totalNights },
          leaseOwner: null, leaseExpiresAtMs: null, updatedAtMs: now }).where(eq(jobs.id, job.id)).run()
        return { jobId: job.id, contentHash }
      }, { behavior: 'immediate' })
    }
    return artifacts ? artifacts.withPublication(publish) : publish()
  }
}
