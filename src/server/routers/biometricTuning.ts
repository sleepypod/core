import { resolvePromotionBuild } from '@/src/biometrics/profiles/promotion-build'
import { referenceTracePageSchema, referenceTraceRequestSchema } from '@/src/biometrics/backtest/reference-trace-page'
import { numericTracePageSchema } from '@/src/biometrics/backtest/numeric-trace-page'
import { replayAdmission, replayAdmissionSchema, replayAdmitter } from '@/src/biometrics/backtest/admission-service'
import { rawSourceDescriptorSchema, rawSourcePageSchema, rawSourcePageResultSchema } from '@/src/biometrics/backtest/raw-catalog'
import { rawScanInputSchema, rawSourceNameSchema } from '@/src/biometrics/backtest/raw-inspection-child'
import { createWaveformDatasetSchema } from '@/src/biometrics/backtest/waveform-selection'
import { locateRawArchives } from '@/src/biometrics/backtest/raw-locate'
import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { biometricsDb, db } from '@/src/db'
import { sideSchema } from '@/src/server/validation-schemas'
import { normalizedMeasurementSchema, previewSummarySchema, referenceImportDescriptorSchema, referenceImportSchema } from '@/src/biometrics/references/contracts'
import { previewReferenceImport } from '@/src/biometrics/references/normalize'
import { commitReferenceSchema, ReferenceStore } from '@/src/biometrics/references/store'
import { compareReadingsSchema, comparisonReportSchema, compareStoredReadings } from '@/src/biometrics/references/comparison'
import { biometricManifest, manifestHash, resolveConfig } from '@/src/biometrics/algorithms/registry'
import { ProfileStore, revisionInput } from '@/src/biometrics/profiles/store'
import { biometricConfigSchema, overrideSchema, profileOverviewSchema, revisionSchema } from '@/src/biometrics/profiles/contracts'
import { diffProfiles } from '@/src/biometrics/profiles/diff'
import { profileOverview } from '@/src/biometrics/profiles/overview'
import { activationIntentSchema, requestManualActivation, validatedActivationIntentSchema, requestValidatedActivationWithBuild, validatedActivationReviewSchema, reviewValidatedActivation } from '@/src/biometrics/profiles/activation'
import { activationStatus, activationStatusSchema } from '@/src/biometrics/profiles/status'
import { activationEventSchema, activationHistorySchema, listActivationHistory } from '@/src/biometrics/profiles/history'
import { DatasetStore, createDatasetSchema } from '@/src/biometrics/backtest/datasets'
import { listReplaySessions, sessionCapabilities, sessionPageSchema, sessionCapabilitiesSchema } from '@/src/biometrics/backtest/discovery'
import { submitBacktest, submitBacktestSchema, resolveSubmissionBuild } from '@/src/biometrics/backtest/submission'
import { traceRequestSchema, tracePageSchema } from '@/src/biometrics/backtest/trace-contracts'
import { coordinatorRequest } from '@/src/biometrics/backtest/coordinator-service'
import { BacktestJobStore } from '@/src/biometrics/backtest/jobs'
import { describeJob, jobDescriptorSchema, resultDescriptorSchema } from '@/src/biometrics/backtest/descriptors'
import { experimentProtocolSchema } from '@/src/biometrics/backtest/contracts'
import { datasetDescriptorSchema } from '@/src/biometrics/backtest/contracts'
import { datasetBundleIndexSchema, datasetBundleTarBytes } from '@/src/biometrics/backtest/dataset-export'
import { deviceSettings } from '@/src/db/schema'
import { ReferenceInputError } from '@/src/biometrics/references/time'
import { countUnlinkedLegacyReferences, linkLegacyReferences } from '@/src/biometrics/references/legacy'

/** UI and MCP call this shared service surface under the existing LAN trust model. */
async function references<T>(action: (store: ReferenceStore) => T | Promise<T>): Promise<T> {
  try {
    return await action(new ReferenceStore(biometricsDb))
  }
  catch (error) {
    if (error instanceof ReferenceInputError) {
      const code = error.code === 'WORKER_UNAVAILABLE'
        ? 'SERVICE_UNAVAILABLE'
        : error.code === 'NOT_FOUND' || error.code === 'REFERENCE_DELETED' || error.code === 'DATASET_RELEASED' || error.code === 'RESULT_RELEASED'
          ? 'NOT_FOUND'
          : error.code === 'STALE_PREVIEW' || error.code === 'REVISION_CONFLICT' || error.code === 'STALE_BINDING'
            ? 'CONFLICT'
            : error.code === 'RESOURCE_LIMIT' ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST'
      throw new TRPCError({ code, message: `${error.code}: ${error.message}`, cause: error })
    }
    throw error
  }
}
function profiles<T>(action: (store: ProfileStore) => T): T {
  try {
    return action(new ProfileStore(db))
  }
  catch (error) {
    if (error instanceof z.ZodError) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid profile request', cause: error })
    if (error instanceof Error && /^(NOT_FOUND|PROFILE_INCOMPATIBLE|IDEMPOTENCY_CONFLICT|RESOURCE_LIMIT|Invalid |Unknown |Duplicate |Override |Non-finite|JSON resource limit|Expected finite JSON)/.test(error.message)) {
      const code = error.message.startsWith('NOT_FOUND')
        ? 'NOT_FOUND'
        : error.message.startsWith('IDEMPOTENCY_CONFLICT') ? 'CONFLICT' : 'BAD_REQUEST'
      throw new TRPCError({ code, message: error.message, cause: error })
    }
    throw error
  }
}
const profileCursorSchema = z.object({ side: sideSchema, familyId: z.string().uuid().optional(), beforeId: z.string().uuid().optional(), beforeCreatedAtMs: z.number().int().nonnegative().optional() })
  .strict().refine(input => (input.beforeId === undefined) === (input.beforeCreatedAtMs === undefined), { message: 'Supply both cursor fields' })
const importIdSchema = z.object({ id: z.string().uuid() }).strict()

const experimentDescriptorSchema = z.object({ id: z.string().uuid(), datasetId: z.string().uuid(), side: sideSchema, protocol: experimentProtocolSchema,
  protocolHash: z.string(), holdoutAccesses: z.number(), createdAtMs: z.number() })

export const biometricTuningRouter = router({
  activateProfile: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/activate', protect: false, tags: ['Biometric tuning'] } })
    .input(activationIntentSchema.omit({ action: true }).extend({ revisionId: z.string().uuid() }))
    .output(activationEventSchema)
    .mutation(({ input }) => references(() => profiles(() => requestManualActivation(db, { ...input, action: 'activate' })))),

  reviewValidatedActivation: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/validated-activation-review', protect: false, tags: ['Biometric tuning'] } })
    .input(validatedActivationReviewSchema)
    .output(z.object({ eligible: z.literal(true) }))
    .query(({ input }) => references(() => reviewValidatedActivation(db, biometricsDb, input,
      () => resolvePromotionBuild(biometricsDb, input.evaluationId)))),

  activateValidatedProfile: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/activate-validated', protect: false, tags: ['Biometric tuning'] } })
    .input(validatedActivationIntentSchema.omit({ action: true }))
    .output(activationEventSchema)
    .mutation(({ input }) => references(() => requestValidatedActivationWithBuild(db, biometricsDb, { ...input, action: 'activate' },
      () => resolvePromotionBuild(biometricsDb, input.evaluationId)))),

  resetProfile: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/reset', protect: false, tags: ['Biometric tuning'] } })
    .input(activationIntentSchema.omit({ action: true, revisionId: true }))
    .output(activationEventSchema)
    .mutation(({ input }) => references(() => profiles(() => requestManualActivation(db, { ...input, action: 'reset', revisionId: null })))),

  rollbackProfile: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/rollback', protect: false, tags: ['Biometric tuning'] } })
    .input(activationIntentSchema.omit({ action: true }))
    .output(activationEventSchema)
    .mutation(({ input }) => references(() => profiles(() => requestManualActivation(db, { ...input, action: 'rollback' })))),

  getActivationStatus: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/activation-status', protect: false, tags: ['Biometric tuning'] } })
    .input(z.object({ side: sideSchema, id: z.string().uuid().optional() }).strict())
    .output(activationStatusSchema)
    .query(({ input }) => references(() => activationStatus(db, biometricsDb, input.side, input.id))),

  listActivationHistory: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/activations', protect: false, tags: ['Biometric tuning'] } })
    .input(z.object({ side: sideSchema, beforeGeneration: z.number().int().positive().optional() }).strict())
    .output(activationHistorySchema)
    .query(({ input }) => listActivationHistory(db, input.side, input.beforeGeneration)),

  listSessions: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/sessions', protect: false, tags: ['Biometric tuning'] } })
    .input(z.object({ side: sideSchema, beforeStartMs: z.number().int().nonnegative().optional(), beforeId: z.number().int().positive().optional() }).strict()
      .refine(input => (input.beforeStartMs === undefined) === (input.beforeId === undefined), { message: 'Supply both cursor fields' }))
    .output(sessionPageSchema)
    .query(({ input }) => references(() => listReplaySessions(biometricsDb, input.side,
      input.beforeId !== undefined && input.beforeStartMs !== undefined ? { startMs: input.beforeStartMs, id: input.beforeId } : undefined))),

  getSessionCapabilities: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/sessions/{id}/capabilities', protect: false, tags: ['Biometric tuning'] } })
    .input(z.object({ id: z.number().int().positive(), side: sideSchema }).strict())
    .output(sessionCapabilitiesSchema)
    .query(({ input }) => references(() => sessionCapabilities(biometricsDb, input.side, input.id))),

  createExperiment: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/experiments', protect: false, tags: ['Biometric tuning'] } })
    .input(z.object({ datasetId: z.string().uuid(), protocol: experimentProtocolSchema, idempotencyKey: z.string().min(1).max(200) }).strict())
    .output(experimentDescriptorSchema)
    .mutation(({ input }) => references(() => coordinatorRequest(biometricsDb, { type: 'createExperiment', input })
      .then(experiment => ({ ...experiment, protocol: experimentProtocolSchema.parse(experiment.protocol) })))),

  getExperiment: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/experiments/{id}', protect: false, tags: ['Biometric tuning'] } })
    .input(importIdSchema)
    .output(experimentDescriptorSchema)
    .query(({ input }) => references(() => new BacktestJobStore(biometricsDb).getExperiment(input.id))),

  listExperiments: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/experiments', protect: false, tags: ['Biometric tuning'] } })
    .input(z.object({ side: sideSchema, beforeId: z.string().uuid().optional(), beforeCreatedAtMs: z.number().int().nonnegative().optional() }).strict()
      .refine(input => (input.beforeId === undefined) === (input.beforeCreatedAtMs === undefined), { message: 'Supply both cursor fields' }))
    .output(z.object({ items: z.array(experimentDescriptorSchema), nextCursor: z.object({ createdAtMs: z.number(), id: z.string().uuid() }).nullable() }))
    .query(({ input }) => references(() => new BacktestJobStore(biometricsDb).pageExperiments(input.side,
      input.beforeId !== undefined && input.beforeCreatedAtMs !== undefined ? { id: input.beforeId, createdAtMs: input.beforeCreatedAtMs } : undefined))),

  enqueueBacktest: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/backtests', protect: false, tags: ['Biometric tuning'] } })
    .input(submitBacktestSchema)
    .output(jobDescriptorSchema)
    .mutation(async ({ input }) => {
      const build = await references(() => resolveSubmissionBuild(biometricsDb, input))
      if ('existing' in build) return describeJob(build.existing)
      return references(() => profiles(() => describeJob(submitBacktest(db, biometricsDb, build.evaluatorBuildHash, input, build.pythonBuildHash))))
    }),

  listBacktests: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/backtests', protect: false, tags: ['Biometric tuning'] } })
    .input(z.object({ side: sideSchema, beforeId: z.string().uuid().optional(), beforeCreatedAtMs: z.number().int().nonnegative().optional() }).strict()
      .refine(input => (input.beforeId === undefined) === (input.beforeCreatedAtMs === undefined), { message: 'Supply both cursor fields' }))
    .output(z.object({ items: z.array(jobDescriptorSchema), nextCursor: z.object({ createdAtMs: z.number(), id: z.string().uuid() }).nullable() }))
    .query(({ input }) => references(() => {
      const page = new BacktestJobStore(biometricsDb).page(input.side,
        input.beforeId !== undefined && input.beforeCreatedAtMs !== undefined ? { id: input.beforeId, createdAtMs: input.beforeCreatedAtMs } : undefined)
      return { ...page, items: page.items.map(describeJob) }
    })),

  getBacktest: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/backtests/{id}', protect: false, tags: ['Biometric tuning'] } })
    .input(importIdSchema)
    .output(jobDescriptorSchema)
    .query(({ input }) => references(() => describeJob(new BacktestJobStore(biometricsDb).get(input.id)))),

  cancelBacktest: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/backtests/{id}/cancel', protect: false, tags: ['Biometric tuning'] } })
    .input(importIdSchema)
    .output(jobDescriptorSchema)
    .mutation(({ input }) => references(() => describeJob(new BacktestJobStore(biometricsDb).cancel(input.id)))),

  getBacktestResult: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/backtests/{id}/result', protect: false, tags: ['Biometric tuning'] } })
    .input(importIdSchema)
    .output(resultDescriptorSchema.nullable())
    .query(({ input }) => references(() => coordinatorRequest(biometricsDb, { type: 'readResult', input }))),

  getBacktestSummary: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/backtests/{id}/summary', protect: false, tags: ['Biometric tuning'] } })
    .input(importIdSchema)
    .output(resultDescriptorSchema.extend({ projection: z.enum(['scores_without_stage_trace_rows_v1', 'scores_without_replay_trace_rows_v1']), contentHashScope: z.literal('complete_retained_report') }).nullable())
    .query(({ input }) => references(() => coordinatorRequest(biometricsDb, { type: 'readSummary', input }))),

  getBacktestTrace: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/backtests/{id}/trace', protect: false, tags: ['Biometric tuning'] } })
    .input(traceRequestSchema)
    .output(tracePageSchema)
    .query(({ input }) => references(() => coordinatorRequest(biometricsDb, { type: 'readTrace', input }))),

  getBacktestReferenceTrace: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/backtests/{id}/reference-trace', protect: false, tags: ['Biometric tuning'] } })
    .input(referenceTraceRequestSchema)
    .output(referenceTracePageSchema)
    .query(({ input }) => references(() => coordinatorRequest(biometricsDb, { type: 'readReferenceTrace', input }))),

  getBacktestNumericTrace: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/backtests/{id}/numeric-trace', protect: false, tags: ['Biometric tuning'] } })
    .input(traceRequestSchema)
    .output(numericTracePageSchema)
    .query(({ input }) => references(() => coordinatorRequest(biometricsDb, { type: 'readNumericTrace', input }))),

  releaseBacktestResult: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/backtests/{id}/result/release', protect: false, tags: ['Biometric tuning'] } })
    .input(importIdSchema.extend({ expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/) }))
    .output(resultDescriptorSchema.nullable())
    .mutation(({ input }) => references(() => coordinatorRequest(biometricsDb, { type: 'releaseResult', input }))),

  getReplayAdmission: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/replay-admission', protect: false, tags: ['Biometric tuning'] } })
    .input(z.object({}).strict())
    .output(replayAdmissionSchema)
    .query(() => replayAdmission(biometricsDb)),

  inspectRawSource: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/raw-sources/inspect', protect: false, tags: ['Biometric tuning'] } })
    .input(rawScanInputSchema)
    .output(z.discriminatedUnion('status', [
      z.object({ status: z.literal('inspected'), nextCursor: rawSourceNameSchema, source: rawSourceDescriptorSchema }).strict(),
      z.object({ status: z.literal('source_unavailable'), nextCursor: rawSourceNameSchema }).strict(),
      z.object({ status: z.literal('archive_unavailable'), nextCursor: z.null() }).strict(),
      z.object({ status: z.literal('complete'), nextCursor: z.null() }).strict(),
      z.object({ status: z.literal('deferred'), nextCursor: rawSourceNameSchema.nullable() }).strict(),
    ]))
    .mutation(({ input }) => references(() => coordinatorRequest(biometricsDb, { type: 'inspectRawSource', input }, { admit: replayAdmitter(biometricsDb) }))),

  listRawSources: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/raw-sources', protect: false, tags: ['Biometric tuning'] } })
    .input(rawSourcePageSchema)
    .output(rawSourcePageResultSchema)
    .query(({ input }) => references(() => coordinatorRequest(biometricsDb, { type: 'pageRawSources', input }))),

  locateRawArchives: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/raw-sources/locate', protect: false, tags: ['Biometric tuning'] } })
    .input(z.object({ startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative() }).strict()
      .refine(input => input.startMs <= input.endMs && input.endMs - input.startMs <= 36 * 3600_000, { message: 'Use a window of at most 36 hours' }))
    .output(z.array(z.object({ name: rawSourceNameSchema, afterName: rawSourceNameSchema.nullable() })))
    .query(({ input }) => locateRawArchives(input.startMs, input.endMs)),

  createWaveformDataset: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/waveform-datasets', protect: false, tags: ['Biometric tuning'] } })
    .input(createWaveformDatasetSchema)
    .output(z.discriminatedUnion('status', [
      z.object({ status: z.literal('published'), dataset: datasetDescriptorSchema }).strict(),
      z.object({ status: z.literal('deferred') }).strict(),
    ]))
    .mutation(({ input }) => references(() => coordinatorRequest(biometricsDb, { type: 'createWaveformDataset', input }, { admit: replayAdmitter(biometricsDb) }).then(result => result.status === 'published' ? { ...result, dataset: datasetDescriptorSchema.parse(result.dataset) } : result))),

  createDataset: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/datasets', protect: false, tags: ['Biometric tuning'] } })
    .input(createDatasetSchema.omit({ timezone: true }))
    .output(datasetDescriptorSchema)
    .mutation(({ input }) => references(() => {
      const timezone = db.select({ timezone: deviceSettings.timezone }).from(deviceSettings).get()?.timezone ?? 'America/Los_Angeles'
      return coordinatorRequest(biometricsDb, { type: 'createDataset', input: { ...input, timezone } }).then(result => datasetDescriptorSchema.parse(result))
    })),

  releaseDataset: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/datasets/{id}/release', protect: false, tags: ['Biometric tuning'] } })
    .input(importIdSchema)
    .output(datasetDescriptorSchema)
    .mutation(({ input }) => references(() => coordinatorRequest(biometricsDb, { type: 'releaseDataset', input }).then(result => datasetDescriptorSchema.parse(result)))),

  getDataset: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/datasets/{id}', protect: false, tags: ['Biometric tuning'] } })
    .input(importIdSchema)
    .output(datasetDescriptorSchema)
    .query(({ input }) => references(() => coordinatorRequest(biometricsDb, { type: 'datasetDescriptor', input }).then(result => datasetDescriptorSchema.parse(result)))),

  describeDatasetExport: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/datasets/{id}/export-index', protect: false, tags: ['Biometric tuning'] } })
    .input(importIdSchema)
    .output(z.object({ index: datasetBundleIndexSchema, download: z.object({ method: z.literal('GET'), path: z.string(), contentType: z.literal('application/x-tar'), bytes: z.number().int().nonnegative() }).strict() }).strict())
    .query(({ input }) => references(() => coordinatorRequest(biometricsDb, { type: 'exportDataset', input }).then(result => ({ index: result.index,
      download: { method: 'GET' as const, path: `/api/biometric-tuning/datasets/${input.id}/export`, contentType: 'application/x-tar' as const, bytes: datasetBundleTarBytes(result.index) } })))),

  listDatasets: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/datasets', protect: false, tags: ['Biometric tuning'] } })
    .input(z.object({ side: sideSchema, beforeId: z.string().uuid().optional(), beforeCreatedAtMs: z.number().int().nonnegative().optional() }).strict()
      .refine(input => (input.beforeId === undefined) === (input.beforeCreatedAtMs === undefined), { message: 'Supply both cursor fields' }))
    .output(z.object({ items: z.array(datasetDescriptorSchema), nextCursor: z.object({ createdAtMs: z.number(), id: z.string().uuid() }).nullable() }))
    .query(({ input }) => references(() => {
      const page = new DatasetStore(biometricsDb).page(input.side,
        input.beforeId !== undefined && input.beforeCreatedAtMs !== undefined ? { id: input.beforeId, createdAtMs: input.beforeCreatedAtMs } : undefined)
      return { ...page, items: page.items.map(row => datasetDescriptorSchema.parse(row)) }
    })),

  getManifest: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/manifest', protect: false, tags: ['Biometric tuning'] } })
    .input(z.object({}).strict())
    .output(z.object({ manifestHash: z.string(), manifest: z.unknown(), activationAvailable: z.boolean() }))
    .query(() => ({ manifestHash, manifest: biometricManifest, activationAvailable: true })),

  getProfileOverview: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/profiles/overview', protect: false, tags: ['Biometric tuning'] } })
    .input(z.object({ side: sideSchema }).strict())
    .output(profileOverviewSchema)
    .query(({ input }) => profiles(() => profileOverview(db, biometricsDb, input.side))),

  resolveProfile: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/profiles/resolve', protect: false, tags: ['Biometric tuning'] } })
    .input(z.object({ overrides: revisionInput.shape.overrides, baseManifestHash: revisionInput.shape.baseManifestHash }).strict())
    .output(z.object({ resolved: biometricConfigSchema, hash: z.string(), manifestHash: z.string(), overrides: z.array(overrideSchema), provenance: z.record(z.string(), z.literal('override')) }))
    .mutation(({ input }) => profiles(() => resolveConfig(input.overrides, input.baseManifestHash))),

  createProfileRevision: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/profiles', protect: false, tags: ['Biometric tuning'] } })
    .input(revisionInput.extend({ origin: z.enum(['manual', 'agent']) }))
    .output(revisionSchema)
    .mutation(({ input }) => revisionSchema.parse(profiles(store => store.createRevision(input)))),

  diffProfileRevision: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/profiles/diff', protect: false, tags: ['Biometric tuning'] } })
    .input(z.object({ side: sideSchema, revisionId: z.string().uuid().nullable(), againstRevisionId: z.string().uuid().nullable() }).strict())
    .output(z.object({ revisionId: z.string().uuid().nullable(), againstRevisionId: z.string().uuid().nullable(), beforeHash: z.string(), afterHash: z.string(),
      changes: z.array(z.object({ path: z.string(), before: z.unknown(), after: z.unknown() })), intentChangedPaths: z.array(z.string()) }))
    .mutation(({ input }) => profiles(store => diffProfiles(store, input.side, input.revisionId, input.againstRevisionId))),

  validateProfileRevision: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/profiles/{id}/validate', protect: false, tags: ['Biometric tuning'] } })
    .input(importIdSchema.extend({ side: sideSchema }))
    .output(z.object({ id: z.string().uuid(), resolvedHash: z.string(), compatible: z.literal(true), evidence: z.literal('not_checked'), limitations: z.array(z.string()) }))
    .mutation(({ input }) => profiles((store) => {
      const valid = store.validateRevision(input.id, input.side)
      return { id: input.id, resolvedHash: valid.hash, compatible: true as const, evidence: 'not_checked' as const,
        limitations: ['Schema and engine compatibility do not establish improved biometric agreement.'] }
    })),

  getProfileRevision: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/profiles/{id}', protect: false, tags: ['Biometric tuning'] } })
    .input(importIdSchema)
    .output(revisionSchema)
    .query(({ input }) => revisionSchema.parse(profiles(store => store.getRevision(input.id)))),

  listProfileRevisions: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/profiles', protect: false, tags: ['Biometric tuning'] } })
    .input(profileCursorSchema)
    .output(z.object({ items: z.array(revisionSchema), nextCursor: z.object({ createdAtMs: z.number(), id: z.string().uuid() }).nullable() }))
    .query(({ input }) => {
      const page = profiles(store => store.listRevisions(input.side,
        input.beforeId !== undefined && input.beforeCreatedAtMs !== undefined ? { id: input.beforeId, createdAtMs: input.beforeCreatedAtMs } : undefined, input.familyId))
      return { ...page, items: page.items.map(row => revisionSchema.parse(row)) }
    }),

  compareReadings: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/compare', protect: false, tags: ['Biometric tuning'] } })
    .input(compareReadingsSchema)
    .output(comparisonReportSchema)
    .mutation(({ input }) => references(() => compareStoredReadings(biometricsDb, input))),

  previewImport: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/references/preview', protect: false, tags: ['Biometric tuning'] } })
    .input(referenceImportSchema)
    .output(previewSummarySchema)
    .mutation(({ input }) => references(() => previewReferenceImport(input).summary)),

  commitImport: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/references/commit', protect: false, tags: ['Biometric tuning'] } })
    .input(commitReferenceSchema)
    .output(referenceImportDescriptorSchema.extend({ alreadyImported: z.boolean() }))
    .mutation(({ input }) => references(store => store.commit(input))),

  listImports: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/references', protect: false, tags: ['Biometric tuning'] } })
    .input(z.object({ side: sideSchema, beforeCreatedAtMs: z.number().int().nonnegative().optional(), beforeId: z.string().uuid().optional() }).strict()
      .refine(input => (input.beforeId === undefined) === (input.beforeCreatedAtMs === undefined), { message: 'Supply both cursor fields' }))
    .output(z.object({ items: z.array(referenceImportDescriptorSchema), nextCursor: z.object({ createdAtMs: z.number(), id: z.string().uuid() }).nullable() }))
    .query(({ input }) => references(store => store.list(input.side, input.beforeId !== undefined && input.beforeCreatedAtMs !== undefined
      ? { createdAtMs: input.beforeCreatedAtMs, id: input.beforeId }
      : undefined))),

  countLegacyReferences: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/references/legacy', protect: false, tags: ['Biometric tuning'] } })
    .input(z.object({ side: sideSchema }).strict())
    .output(z.object({ vitals: z.number().int(), stages: z.number().int() }))
    .query(({ input }) => countUnlinkedLegacyReferences(biometricsDb, input.side)),

  linkLegacyReferences: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/references/legacy/link', protect: false, tags: ['Biometric tuning'] } })
    .input(z.object({ side: sideSchema }).strict())
    .output(z.object({ vitals: z.number().int(), stages: z.number().int(), imports: z.number().int() }))
    .mutation(({ input }) => references(() => linkLegacyReferences(biometricsDb, input.side))),

  getImport: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/references/{id}', protect: false, tags: ['Biometric tuning'] } })
    .input(importIdSchema)
    .output(referenceImportDescriptorSchema)
    .query(({ input }) => references(store => store.get(input.id))),

  getImportMeasurements: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/references/{id}/measurements', protect: false, tags: ['Biometric tuning'] } })
    .input(importIdSchema.extend({ afterId: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(500).default(500) }))
    .output(z.object({ items: z.array(normalizedMeasurementSchema.extend({ id: z.number().int() })), nextCursor: z.number().int().nullable() }))
    .query(({ input }) => references(store => store.measurements(input.id, input.afterId, input.limit))),

  deleteImport: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/biometric-tuning/references/{id}', protect: false, tags: ['Biometric tuning'] } })
    .input(importIdSchema)
    .output(z.object({ id: z.string().uuid(), deletedAtMs: z.number().nullable() }))
    .mutation(({ input }) => references(store => store.delete(input.id))),
})
