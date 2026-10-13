import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { biometricsDb, db } from '@/src/db'
import { calibrationProfiles, movement, referenceStages, sleepRecords, vitals } from '@/src/db/biometrics-schema'
import { sideSettings, stageClassifierChanges } from '@/src/db/schema'
import { and, asc, desc, eq, gt, gte, lte } from 'drizzle-orm'
import { sideSchema } from '@/src/server/validation-schemas'
import {
  changedSegments,
  classifyNights,
  piezoCalibrationQuality,
  type NightInputs,
  type SleepStageBlock,
} from '@/src/lib/sleep-stages'
import {
  DEFAULT_STAGE_CLASSIFIER,
  resolveStageClassifier,
  stageClassifierSchema,
  STAGE_ENGINES,
  STAGE_METRICS,
  STAGE_RULESET_PRESETS,
  summarizeRulesetChange,
  type StageClassifier,
} from '@/src/lib/sleep-stage-rules'

type Side = 'left' | 'right'

/** The side's stored classifier, or the defaults. */
export async function loadStageClassifier(side: Side): Promise<StageClassifier> {
  const [row] = await db
    .select({ stageClassifier: sideSettings.stageClassifier })
    .from(sideSettings)
    .where(eq(sideSettings.side, side))
    .limit(1)
  return resolveStageClassifier(row?.stageClassifier)
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

async function loadReference(side: Side, windowStart: Date, windowEnd: Date): Promise<SleepStageBlock[]> {
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
    .output(classifierStateSchema.extend({
      defaults: stageClassifierSchema,
      engines: z.array(z.object({ id: z.string(), label: z.string(), description: z.string() })),
      presets: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), classifier: stageClassifierSchema })),
      changes: z.array(changeSchema),
    }))
    .query(async ({ input }) => {
      try {
        const [row] = await db
          .select({ stageClassifier: sideSettings.stageClassifier })
          .from(sideSettings)
          .where(eq(sideSettings.side, input.side))
          .limit(1)
        const stored = row?.stageClassifier ?? null
        return {
          classifier: resolveStageClassifier(stored),
          isDefault: stored === null || !stageClassifierSchema.safeParse(stored).success,
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
    .output(classifierStateSchema)
    .mutation(async ({ input }) => {
      try {
        const [row] = await db
          .select({ stageClassifier: sideSettings.stageClassifier })
          .from(sideSettings)
          .where(eq(sideSettings.side, input.side))
          .limit(1)
        if (!row) {
          throw new TRPCError({ code: 'NOT_FOUND', message: `Side settings for ${input.side} not found` })
        }
        const storedBefore = row.stageClassifier === null || !stageClassifierSchema.safeParse(row.stageClassifier).success
          ? null
          : resolveStageClassifier(row.stageClassifier)

        const before = storedBefore ?? DEFAULT_STAGE_CLASSIFIER
        const after = input.classifier ?? DEFAULT_STAGE_CLASSIFIER
        const summary = input.classifier === null
          ? (storedBefore === null ? 'No change' : 'Reset to default')
          : summarizeRulesetChange(before.ruleset, after.ruleset)
        // Agreements read biometrics.db asynchronously, so compute them before
        // the write; the transaction then re-reads the classifier so a save that
        // raced in between cannot be logged against a stale "before".
        const agreementBefore = summary === 'No change' ? null : await latestAgreement(input.side, before)
        const agreementAfter = summary === 'No change' ? null : await latestAgreement(input.side, after)
        const rawBefore = JSON.stringify(row.stageClassifier)

        db.transaction((tx) => {
          const current = tx
            .select({ stageClassifier: sideSettings.stageClassifier })
            .from(sideSettings)
            .where(eq(sideSettings.side, input.side))
            .get()
          if (!current || JSON.stringify(current.stageClassifier) !== rawBefore) {
            throw new TRPCError({ code: 'CONFLICT', message: `Stage classifier for ${input.side} changed during save; reload and try again` })
          }
          tx.update(sideSettings)
            .set({ stageClassifier: input.classifier, updatedAt: new Date() })
            .where(eq(sideSettings.side, input.side))
            .run()
          if (summary !== 'No change') {
            tx.insert(stageClassifierChanges).values({
              side: input.side,
              before: storedBefore,
              after: input.classifier,
              summary,
              agreementBefore,
              agreementAfter,
            }).run()
          }
        })

        return {
          classifier: after,
          isDefault: input.classifier === null,
        }
      }
      catch (error) {
        if (error instanceof TRPCError) throw error
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
})
