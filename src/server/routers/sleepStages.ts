import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { biometricsDb, db } from '@/src/db'
import { calibrationProfiles, movement, referenceStages, sleepRecords, vitals } from '@/src/db/biometrics-schema'
import { consumeStageView, stageViewSchema } from '@/src/biometrics/profiles/stage-view'
import { writeLegacyStageClassifier } from '@/src/biometrics/profiles/legacy-stage'
import { ReferenceInputError } from '@/src/biometrics/references/time'
import { ProfileStore } from '@/src/biometrics/profiles/store'
import type { Override } from '@/src/biometrics/algorithms/registry'
import { sideSettings, sideStageModels, stageClassifierChanges, stageModelLibrary } from '@/src/db/schema'
import {
  classifyWithStageModel,
  failingTestVectors,
  stageModelBlocks,
  stageModelContract,
  stageModelSchema,
  type StageModel,
} from '@/src/lib/personal-stage-model'
import { and, asc, desc, eq, gt, gte, lte } from 'drizzle-orm'
import { sideSchema } from '@/src/server/validation-schemas'
import {
  changedSegments,
  classifyNights,
  classifySleepStages,
  piezoCalibrationQuality,
  scoreAgainstReference,
  type NightInputs,
  type SleepStageBlock,
} from '@/src/lib/sleep-stages'
import {
  DEFAULT_STAGE_CLASSIFIER,
  resolveStageClassifier,
  SLEEP_STAGES,
  stageClassifierSchema,
  STAGE_ENGINES,
  STAGE_METRICS,
  STAGE_RULESET_PRESETS,
  summarizeRulesetChange,
  type StageClassifier,
} from '@/src/lib/sleep-stage-rules'

type Side = 'left' | 'right'

function validateModel(model: StageModel) {
  if (!stageModelContract(model)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown model feature contract' })
  if (failingTestVectors(model).length) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Model fails its test vectors' })
}

/** Called inside the same transaction as any selection change. Identical uploads are idempotent. */
function saveLibraryModel(tx: Pick<typeof db, 'select' | 'insert'>, side: Side, model: unknown, version: string, uploadedAt: Date) {
  const existing = tx.select({ id: stageModelLibrary.id }).from(stageModelLibrary)
    .where(and(eq(stageModelLibrary.side, side), eq(stageModelLibrary.model, model))).get()
  if (existing) return existing.id
  return tx.insert(stageModelLibrary).values({ side, model, version, uploadedAt }).returning({ id: stageModelLibrary.id }).get().id
}

/** The side's stored model when it is marked active and still validates; null means the rules stage the side. */
export function loadActiveStageModel(side: Side): StageModel | null {
  const row = db.select().from(sideStageModels).where(and(eq(sideStageModels.side, side), eq(sideStageModels.active, true))).get()
  if (!row) return null
  const parsed = stageModelSchema.safeParse(row.model)
  return parsed.success ? parsed.data : null
}

/** Rules delivered to the stage consumer, with the actual bundle identity. */
export function loadStageView(side: Side) {
  return consumeStageView(db, biometricsDb, side)
}

export async function loadStageClassifier(side: Side): Promise<StageClassifier> {
  return loadStageView(side).classifier
}

/** Vitals, movement and piezo calibration quality for one side's window. */
export async function loadStageInputs(side: Side, windowStart: Date, windowEnd: Date) {
  const vitalsData = await biometricsDb
    .select()
    .from(vitals)
    .where(
      and(
        eq(vitals.side, side),
        gte(vitals.timestamp, windowStart),
        lte(vitals.timestamp, windowEnd)
      )
    )
    .orderBy(asc(vitals.timestamp))

  const movementData = await biometricsDb
    .select()
    .from(movement)
    .where(
      and(
        eq(movement.side, side),
        gte(movement.timestamp, windowStart),
        lte(movement.timestamp, windowEnd)
      )
    )
    .orderBy(asc(movement.timestamp))

  const [piezoProfile] = await biometricsDb
    .select({ qualityScore: calibrationProfiles.qualityScore })
    .from(calibrationProfiles)
    .where(
      and(
        eq(calibrationProfiles.side, side),
        eq(calibrationProfiles.sensorType, 'piezo'),
      )
    )
    .limit(1)

  return { vitalsData, movementData, calibrationQuality: piezoCalibrationQuality(piezoProfile) }
}

export async function loadReference(side: Side, windowStart: Date, windowEnd: Date): Promise<SleepStageBlock[]> {
  const rows = await biometricsDb
    .select()
    .from(referenceStages)
    .where(
      and(
        eq(referenceStages.side, side),
        lte(referenceStages.start, windowEnd),
        gt(referenceStages.end, windowStart)
      )
    )
    .orderBy(asc(referenceStages.start))
  return rows.map(r => ({ start: r.start.getTime(), end: r.end.getTime(), stage: r.stage }))
}

const stageEnum = z.enum(['wake', 'light', 'deep', 'rem'])
const stageNumbers = z.object({ wake: z.number(), light: z.number(), deep: z.number(), rem: z.number() })
const rangeSchema = z.object({ min: z.number(), max: z.number() })

const ruleListStatsSchema = z.object({
  epochs: z.number(),
  hits: z.array(z.number()),
  matches: z.array(z.number()),
  shadowedBy: z.array(z.number().nullable()),
  fallbackHits: z.number(),
})

const runSummarySchema = z.object({
  epochs: z.number(),
  nights: z.number(),
  lowSignalNights: z.number(),
  rules: ruleListStatsSchema.nullable(),
  lowSignalRules: ruleListStatsSchema.nullable(),
  metricRanges: z.object(Object.fromEntries(STAGE_METRICS.map(m => [m, rangeSchema.nullable()])) as Record<typeof STAGE_METRICS[number], z.ZodNullable<typeof rangeSchema>>),
  heartRateReadings: z.number(),
  spikesDropped: z.number(),
  smoothed: z.number(),
  transitionFixes: z.number(),
})

const agreementSchema = z.object({
  epochs: z.number(),
  accuracy: z.number(),
  kappa: z.number().nullable(),
  confusion: z.object(Object.fromEntries(SLEEP_STAGES.map(s => [s, stageNumbers])) as Record<typeof SLEEP_STAGES[number], typeof stageNumbers>),
  recall: z.object({ wake: z.number().nullable(), light: z.number().nullable(), deep: z.number().nullable(), rem: z.number().nullable() }),
}).nullable()

const nightStagesSchema = z.object({
  /** Stage blocks of the latest night. */
  blocks: z.array(z.object({ start: z.number(), end: z.number(), stage: stageEnum })),
  /** Percent of epochs per stage, over every night previewed. */
  distribution: stageNumbers,
  /** Mean quality score over the nights previewed. */
  qualityScore: z.number(),
  totalSleepMs: z.number(),
  /** Mean time per stage per night, ms. */
  durations: stageNumbers,
  agreement: agreementSchema,
  stats: runSummarySchema,
})

const classifierStateSchema = z.object({
  classifier: stageClassifierSchema,
  isDefault: z.boolean(),
})

const changeSchema = z.object({
  id: z.number(),
  changedAt: z.number(),
  summary: z.string(),
  before: stageClassifierSchema.nullable(),
  agreementBefore: z.number().nullable(),
  agreementAfter: z.number().nullable(),
})

type LoadedNight = NightInputs & { record: typeof sleepRecords.$inferSelect }

async function loadNights(side: Side, sleepRecordId: number | undefined, nights: number): Promise<LoadedNight[]> {
  const records = await biometricsDb
    .select()
    .from(sleepRecords)
    .where(sleepRecordId === undefined
      ? eq(sleepRecords.side, side)
      : and(eq(sleepRecords.id, sleepRecordId), eq(sleepRecords.side, side)))
    .orderBy(desc(sleepRecords.enteredBedAt))
    .limit(sleepRecordId === undefined ? nights : 1)

  if (records.length === 0 && sleepRecordId !== undefined) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `Sleep record ${sleepRecordId} not found for side '${side}'`,
    })
  }

  return Promise.all(records.map(async record => ({
    record,
    ...await loadStageInputs(side, record.enteredBedAt, record.leftBedAt),
    reference: await loadReference(side, record.enteredBedAt, record.leftBedAt),
  })))
}

/** Agreement with reference stages on the latest night, or null without any. */
async function latestAgreement(side: Side, classifier: StageClassifier): Promise<number | null> {
  const nights = await loadNights(side, undefined, 1)
  if (nights.length === 0 || nights[0].reference.length === 0) return null
  return classifyNights(nights, classifier.ruleset)?.summary.agreement?.accuracy ?? null
}

async function listChanges(side: Side) {
  const rows = await db
    .select()
    .from(stageClassifierChanges)
    .where(eq(stageClassifierChanges.side, side))
    .orderBy(desc(stageClassifierChanges.changedAt), desc(stageClassifierChanges.id))
    .limit(10)
  return rows.map(r => ({
    id: r.id,
    changedAt: r.changedAt.getTime(),
    summary: r.summary,
    before: r.before === null ? null : resolveStageClassifier(r.before),
    agreementBefore: r.agreementBefore,
    agreementAfter: r.agreementAfter,
  }))
}

export const sleepStagesRouter = router({
  /**
   * How a side's sleep stages are classified, plus the defaults, the
   * available engines, the built-in presets to start a custom ruleset from,
   * and the side's recent changes.
   */
  getClassifier: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/sleep-stages/classifier', protect: false, tags: ['Sleep stages'] } })
    .input(z.object({ side: sideSchema }).strict())
    .output(stageViewSchema.extend({
      pending: z.object({ classifier: stageClassifierSchema, generation: z.number().int(), warning: z.string().nullable() }).nullable(),
      defaults: stageClassifierSchema,
      engines: z.array(z.object({ id: z.string(), label: z.string(), description: z.string() })),
      presets: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), classifier: stageClassifierSchema })),
      changes: z.array(changeSchema),
    }))
    .query(async ({ input }) => {
      try {
        const view = loadStageView(input.side)
        const desired = new ProfileStore(db).effective(input.side)
        const pending = desired.binding.generation > (view.provenance.generation ?? 0)
          ? { classifier: desired.resolved.sleep_stages, generation: desired.binding.generation, warning: desired.warning }
          : null
        return {
          ...view,
          pending,
          defaults: DEFAULT_STAGE_CLASSIFIER,
          engines: Object.entries(STAGE_ENGINES).map(([id, e]) => ({ id, ...e })),
          presets: Object.entries(STAGE_RULESET_PRESETS).map(([id, p]) => ({
            id,
            label: p.label,
            description: p.description,
            classifier: { engine: 'rules' as const, ruleset: p.ruleset },
          })),
          changes: await listChanges(input.side),
        }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to load stage classifier: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Save a side's classifier, or pass null to go back to the defaults. Stages
   * are classified on read, so every stored night re-scores with it. Each
   * save that changes something is recorded with its effect on the latest
   * night's agreement with reference stages.
   */
  setClassifier: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/sleep-stages/classifier', protect: false, tags: ['Sleep stages'] } })
    .input(z.object({ side: sideSchema, classifier: stageClassifierSchema.nullable() }).strict())
    .output(classifierStateSchema.extend({ activation: z.object({ generation: z.number().int(), revisionId: z.string().nullable(), state: z.string() }) }))
    .mutation(async ({ input }) => {
      try {
        const row = db.select({ stageClassifier: sideSettings.stageClassifier }).from(sideSettings)
          .where(eq(sideSettings.side, input.side)).get()
        if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: `Side settings for ${input.side} not found` })
        const profiles = new ProfileStore(db)
        const desired = profiles.effective(input.side)
        const revision = desired.binding.desiredRevisionId && !desired.warning
          ? profiles.validateRevision(desired.binding.desiredRevisionId, input.side).revision
          : null
        const personalized = (revision?.overrides as Override[] | undefined)?.some(override => override.path.startsWith('sleep_stages.')) ?? false
        const legacyBefore = desired.binding.generation === 0 && stageClassifierSchema.safeParse(row.stageClassifier).success
          ? resolveStageClassifier(row.stageClassifier)
          : null
        const storedBefore = personalized ? desired.resolved.sleep_stages : legacyBefore
        const before = storedBefore ?? DEFAULT_STAGE_CLASSIFIER
        const after = input.classifier ?? DEFAULT_STAGE_CLASSIFIER
        const summary = input.classifier === null
          ? (storedBefore === null ? 'No change' : 'Reset to default')
          : summarizeRulesetChange(before.ruleset, after.ruleset)
        const agreementBefore = summary === 'No change' ? null : await latestAgreement(input.side, before)
        const agreementAfter = summary === 'No change' ? null : await latestAgreement(input.side, after)
        return db.transaction((tx) => {
          const current = profiles.effective(input.side)
          const legacy = tx.select({ stageClassifier: sideSettings.stageClassifier }).from(sideSettings)
            .where(eq(sideSettings.side, input.side)).get()
          if (!legacy || JSON.stringify(legacy.stageClassifier) !== JSON.stringify(row.stageClassifier)
            || current.binding.generation !== desired.binding.generation || current.hash !== desired.hash) {
            throw new TRPCError({ code: 'CONFLICT', message: `Stage classifier for ${input.side} changed during save; reload and try again` })
          }
          const result = writeLegacyStageClassifier(db, input.side, input.classifier)
          if (summary !== 'No change') {
            tx.insert(stageClassifierChanges).values({ side: input.side, before: storedBefore,
              after: input.classifier, summary, agreementBefore, agreementAfter }).run()
          }
          return result
        }, { behavior: 'immediate' })
      }
      catch (error) {
        if (error instanceof TRPCError) throw error
        if (error instanceof ReferenceInputError && error.code === 'NOT_FOUND') throw new TRPCError({ code: 'NOT_FOUND', message: error.message })
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to save stage classifier: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Classify recent nights with the side's saved classifier and with a
   * candidate, without saving. Each result carries its agreement with
   * reference stages (Apple Watch) when the nights have any, and the
   * per-rule statistics the editor shows. Defaults to the latest night;
   * `nights` widens it to the latest N, `sleepRecordId` picks one.
   */
  previewClassifier: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/sleep-stages/classifier/preview', protect: false, tags: ['Sleep stages'] } })
    .input(z.object({
      side: sideSchema,
      sleepRecordId: z.number().int().optional(),
      nights: z.number().int().min(1).max(14).optional(),
      classifier: stageClassifierSchema,
    }).strict())
    .output(z.object({
      sleepRecordId: z.number().nullable(),
      enteredBedAt: z.number().nullable(),
      leftBedAt: z.number().nullable(),
      nights: z.number(),
      hasReference: z.boolean(),
      saved: nightStagesSchema.nullable(),
      candidate: nightStagesSchema.nullable(),
      /** Where the candidate disagrees with the saved rules on the latest night. */
      changed: z.object({
        segments: z.array(z.object({ start: z.number(), end: z.number() })),
        changed: z.number(),
        total: z.number(),
      }).nullable(),
    }))
    .mutation(async ({ input }) => {
      try {
        const nights = await loadNights(input.side, input.sleepRecordId, input.nights ?? 1)
        if (nights.length === 0) {
          return { sleepRecordId: null, enteredBedAt: null, leftBedAt: null, nights: 0, hasReference: false, saved: null, candidate: null, changed: null }
        }
        const latest = nights[0].record
        const saved = classifyNights(nights, (await loadStageClassifier(input.side)).ruleset)
        const candidate = classifyNights(nights, input.classifier.ruleset)

        return {
          sleepRecordId: latest.id,
          enteredBedAt: latest.enteredBedAt.getTime(),
          leftBedAt: latest.leftBedAt.getTime(),
          nights: nights.length,
          hasReference: nights.some(n => n.reference.length > 0),
          saved: saved?.summary ?? null,
          candidate: candidate?.summary ?? null,
          changed: saved && candidate ? changedSegments(saved.latestEpochs, candidate.latestEpochs) : null,
        }
      }
      catch (error) {
        if (error instanceof TRPCError) throw error
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to preview stage classifier: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  listModels: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/sleep-stages/models', protect: false, tags: ['Sleep stages'] } })
    .input(z.object({ side: sideSchema }).strict())
    .output(z.array(z.object({ id: z.number(), version: z.string(), kind: z.string(), uploadedAt: z.number(),
      metrics: z.record(z.string(), z.unknown()).optional(), selected: z.boolean(), active: z.boolean() })))
    .query(({ input }) => {
      const selected = db.select().from(sideStageModels).where(eq(sideStageModels.side, input.side)).get()
      return db.select().from(stageModelLibrary).where(eq(stageModelLibrary.side, input.side))
        .orderBy(desc(stageModelLibrary.id)).all().flatMap((row) => {
          const parsed = stageModelSchema.safeParse(row.model)
          if (!parsed.success) return []
          const isSelected = JSON.stringify(row.model) === JSON.stringify(selected?.model)
          return [{ id: row.id, version: row.version, kind: parsed.data.kind, uploadedAt: row.uploadedAt.getTime(),
            metrics: parsed.data.metrics, selected: isSelected, active: isSelected && !!selected?.active }]
        })
    }),

  uploadModel: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/sleep-stages/models', protect: false, tags: ['Sleep stages'] } })
    .input(z.object({ side: sideSchema, model: stageModelSchema }).strict())
    .output(z.object({ id: z.number(), version: z.string() }))
    .mutation(({ input }) => {
      validateModel(input.model)
      const id = db.transaction(tx => saveLibraryModel(tx, input.side, input.model, input.model.version, new Date()))
      return { id, version: input.model.version }
    }),

  selectModel: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/sleep-stages/models/selected', protect: false, tags: ['Sleep stages'] } })
    .input(z.object({ side: sideSchema, id: z.number().int().positive(), active: z.boolean() }).strict())
    .output(z.object({ version: z.string(), active: z.boolean() }))
    .mutation(({ input }) => db.transaction((tx) => {
      const row = tx.select().from(stageModelLibrary).where(and(eq(stageModelLibrary.id, input.id), eq(stageModelLibrary.side, input.side))).get()
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Model not found for this side' })
      const model = stageModelSchema.parse(row.model)
      validateModel(model)
      tx.insert(sideStageModels).values({ side: input.side, model, version: model.version, uploadedAt: row.uploadedAt, active: input.active })
        .onConflictDoUpdate({ target: sideStageModels.side, set: { model, version: model.version, uploadedAt: row.uploadedAt, active: input.active } }).run()
      return { version: model.version, active: input.active }
    })),

  /** The side's uploaded personal stage model, if any, and whether it stages the side's nights. */
  getModel: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/sleep-stages/model', protect: false, tags: ['Sleep stages'] } })
    .input(z.object({ side: sideSchema }).strict())
    .output(z.object({ model: stageModelSchema.nullable(), uploadedAt: z.number().nullable(), active: z.boolean() }))
    .query(async ({ input }) => {
      const row = db.select().from(sideStageModels).where(eq(sideStageModels.side, input.side)).get()
      if (!row) return { model: null, uploadedAt: null, active: false }
      const parsed = stageModelSchema.safeParse(row.model)
      return { model: parsed.success ? parsed.data : null, uploadedAt: row.uploadedAt.getTime(), active: parsed.success && row.active }
    }),

  /**
   * Make the stored model stage the side's nights (or go back to the rules). The profile's rules stay
   * the fallback for any night the model cannot stage, and the choice is recorded on every stage read
   * as `stagedBy`.
   */
  setModelActive: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/sleep-stages/model/active', protect: false, tags: ['Sleep stages'] } })
    .input(z.object({ side: sideSchema, active: z.boolean() }).strict())
    .output(z.object({ active: z.boolean(), version: z.string().nullable() }))
    .mutation(async ({ input }) => {
      const row = db.select().from(sideStageModels).where(eq(sideStageModels.side, input.side)).get()
      if (!row || !stageModelSchema.safeParse(row.model).success) {
        if (input.active) throw new TRPCError({ code: 'NOT_FOUND', message: `No valid personal stage model stored for ${input.side}` })
        return { active: false, version: null }
      }
      db.update(sideStageModels).set({ active: input.active }).where(eq(sideStageModels.side, input.side)).run()
      return { active: input.active, version: row.version }
    }),

  /**
   * Upload a personal stage model (or null to remove it). The document must
   * validate, name a known feature contract, and reproduce every one of its
   * own test vectors, so a converter mismatch is refused at the door.
   */
  setModel: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/sleep-stages/model', protect: false, tags: ['Sleep stages'] } })
    .input(z.object({ side: sideSchema, model: stageModelSchema.nullable() }).strict())
    .output(z.object({ stored: z.boolean(), version: z.string().nullable() }))
    .mutation(async ({ input }) => {
      if (input.model === null) {
        db.delete(sideStageModels).where(eq(sideStageModels.side, input.side)).run()
        return { stored: false, version: null }
      }
      if (!stageModelContract(input.model)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Unknown feature contract: ${input.model.featureContract.join(', ')}` })
      }
      const failing = failingTestVectors(input.model)
      if (failing.length > 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Model fails ${failing.length} of its ${input.model.testVectors.length} test vectors (first: ${failing[0]})` })
      }
      const model = input.model
      db.transaction((tx) => {
        const previous = tx.select().from(sideStageModels).where(eq(sideStageModels.side, input.side)).get()
        if (previous) saveLibraryModel(tx, input.side, previous.model, previous.version, previous.uploadedAt)
        saveLibraryModel(tx, input.side, model, model.version, new Date())
        tx.insert(sideStageModels)
          .values({ side: input.side, model, version: model.version, uploadedAt: new Date() })
          .onConflictDoUpdate({ target: sideStageModels.side, set: { model, version: model.version, uploadedAt: new Date() } })
          .run()
      })
      return { stored: true, version: input.model.version }
    }),

  /**
   * Stage recent nights with a personal model (the uploaded one, or one sent
   * inline) and score it against the Watch beside the side's rules on the
   * same nights: the pod-side half of the model pipeline.
   */
  previewModel: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/sleep-stages/model/preview', protect: false, tags: ['Sleep stages'] } })
    .input(z.object({
      side: sideSchema,
      sleepRecordId: z.number().int().optional(),
      nights: z.number().int().min(1).max(30).optional(),
      model: stageModelSchema.optional(),
    }).strict())
    .output(z.object({
      version: z.string().nullable(),
      nights: z.array(z.object({
        sleepRecordId: z.number(),
        enteredBedAt: z.number(),
        leftBedAt: z.number(),
        blocks: z.array(z.object({ start: z.number(), end: z.number(), stage: stageEnum })),
        agreement: agreementSchema,
        rulesAgreement: agreementSchema,
      })),
      pooled: agreementSchema,
      rulesPooled: agreementSchema,
    }))
    .mutation(async ({ input }) => {
      let model: StageModel | null = input.model ?? null
      if (!model) {
        const row = db.select().from(sideStageModels).where(eq(sideStageModels.side, input.side)).get()
        const parsed = row ? stageModelSchema.safeParse(row.model) : null
        if (!parsed?.success) throw new TRPCError({ code: 'NOT_FOUND', message: `No personal stage model stored for ${input.side}` })
        model = parsed.data
      }
      validateModel(model)
      try {
        const loaded = await loadNights(input.side, input.sleepRecordId, input.nights ?? 1)
        const ruleset = (await loadStageClassifier(input.side)).ruleset
        const staged = loaded.map(night => ({
          night,
          epochs: classifyWithStageModel(model, night.record.enteredBedAt, night.record.leftBedAt, night.vitalsData, night.movementData, ruleset),
          rules: classifySleepStages(night.vitalsData, night.movementData, night.calibrationQuality, ruleset),
        }))
        const allReference = staged.flatMap(s => s.night.reference)
        return {
          version: model.version,
          nights: staged.map(s => ({
            sleepRecordId: s.night.record.id,
            enteredBedAt: s.night.record.enteredBedAt.getTime(),
            leftBedAt: s.night.record.leftBedAt.getTime(),
            blocks: stageModelBlocks(s.epochs),
            agreement: scoreAgainstReference(s.epochs, s.night.reference),
            rulesAgreement: scoreAgainstReference(s.rules, s.night.reference),
          })),
          pooled: scoreAgainstReference(staged.flatMap(s => s.epochs), allReference),
          rulesPooled: scoreAgainstReference(staged.flatMap(s => s.rules), allReference),
        }
      }
      catch (error) {
        if (error instanceof TRPCError) throw error
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to preview stage model: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),
})
