/**
 * Sleep and vitals tools, including imports into the reference biometrics tables.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { getCaller, jsonResult, runTool, type Caller } from '@/src/mcp/caller'
import { days, isoDate, optionalSide, side } from '@/src/mcp/schemas'
import { STAGE_RULESET_PRESETS, stageRulesetSchema, type StageClassifier, type StageRule, type StageRuleset } from '@/src/lib/sleep-stage-rules'
import { scoreAgainstReference, type SleepStage, type StageAgreement } from '@/src/lib/sleep-stages'
import { REFERENCE_SAMPLE_RANGE } from '@/src/server/routers/biometrics'
import { nearestWithin, WATCH_PAIRING_WINDOW_MS } from '@/src/biometrics/references/watch-deviation'

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

const DAY_MS = 24 * 60 * 60 * 1000
const EPOCH_MS = 5 * 60 * 1000
const COVERAGE_DAYS = 14
const SEGMENT_LIMIT = 20000
const RECORD_LIMIT = 100
const VITALS_LIMIT = 100000
/** Below this pod-vs-watch heart-rate correlation, HR-ratio rules classify noise. */
const HR_WEAK_CORRELATION = 0.5

const PRESET_IDS = Object.keys(STAGE_RULESET_PRESETS) as [keyof typeof STAGE_RULESET_PRESETS, ...(keyof typeof STAGE_RULESET_PRESETS)[]]

const IMPORT_HINT = `No sleep records overlapping reference stages in the last ${COVERAGE_DAYS} days. Run import_apple_watch_data (or POST /api/biometrics/watch-upload) first; nights without reference stages cannot be scored.`
const UNCOVERED_HINT = 'Reference stages exist for these nights but cover none of the classified epochs, so agreement is null. Check the imported segment times.'

const unixSeconds = z.number().int().min(1_000_000_000).max(4_102_444_800)
const referenceSamples = (metric: keyof typeof REFERENCE_SAMPLE_RANGE) => z.array(z.object({
  timestamp: unixSeconds,
  value: z.number().min(REFERENCE_SAMPLE_RANGE[metric][0]).max(REFERENCE_SAMPLE_RANGE[metric][1]),
})).max(2000).default([])

const presetId = z.enum(PRESET_IDS).optional()
  .describe(`A built-in ruleset preset: ${PRESET_IDS.join(', ')}. Ids come from get_sleep_stage_rules.`)
const ruleset = stageRulesetSchema.optional()
  .describe('A complete ruleset, as returned by get_sleep_stage_rules under classifier.ruleset.')
const overrides = z.array(z.object({
  list: z.enum(['rules', 'lowSignalRules']).default('rules')
    .describe('Which rule list to edit: "rules" (normal nights) or "lowSignalRules" (nights whose piezo calibration quality is below the ruleset\'s lowSignalBelow).'),
  ruleIndex: z.number().int().min(0).describe('Index into that list of the saved classifier.'),
  conditionIndex: z.number().int().min(0).describe('Index into that rule\'s when array.'),
  value: z.number().finite().describe('New threshold for that condition, in the metric\'s unit.'),
})).min(1).max(32).optional()
  .describe('Threshold changes applied to the side\'s saved rules. Everything else in the ruleset stays as saved.')

/** A date-only "YYYY-MM-DD" end bound covers that whole UTC day; datetimes are taken as given. */
function endOfDateOnly(value: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(Date.parse(value) + DAY_MS - 1) : new Date(value)
}

export function registerSleepTools(server: McpServer) {
  server.registerTool('import_apple_watch_data', {
    title: 'Import Apple Watch heart rate, breathing rate, HRV and sleep stages',
    description: 'Sync extracted Apple Health records to one sleeper: heart rate (samples), respiratory rate (breathingRates, breaths/min), '
      + 'HRV SDNN (hrvSdnn, ms) and sleep stages (segments). Send at most 2000 records per array per call; repeat calls are safe. '
      + 'Only Apple Watch records belong here, never ones the sleepypod app wrote to Health (source "sleepypod"). '
      + 'For a complete export.zip or export.xml, stream the file with POST /api/biometrics/watch-upload?side=left|right&days=30 '
      + '(application/octet-stream, 512 MiB maximum, days 1..90; imports heart rate, breathing rate, HRV and stages) instead of placing the export in model context. '
      + 'Stage conflicts are reported without blocking the other imports. Records remain separate from pod measurements.',
    inputSchema: {
      side,
      samples: z.array(z.object({ timestamp: unixSeconds, heartRate: z.number().min(20).max(250) })).max(2000).default([]),
      breathingRates: referenceSamples('breathing_rate'),
      hrvSdnn: referenceSamples('hrv_sdnn'),
      segments: z.array(z.object({ start: unixSeconds, end: unixSeconds, stage: z.enum(['wake', 'light', 'deep', 'rem']) })).max(2000).default([]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ side: sleeper, samples, breathingRates, hrvSdnn, segments }) => runTool(async () => {
    if (!samples.length && !breathingRates.length && !hrvSdnn.length && !segments.length) {
      throw new Error('Provide samples, breathingRates, hrvSdnn or segments. Timestamps are Unix seconds.')
    }
    const caller = getCaller()
    const vitals = samples.length ? await caller.biometrics.importReferenceVitals({ side: sleeper, source: 'apple_watch', samples }) : { written: 0 }
    const breathing = breathingRates.length
      ? await caller.biometrics.importReferenceSamples({ side: sleeper, source: 'apple_watch', metric: 'breathing_rate', samples: breathingRates })
      : { written: 0 }
    const hrv = hrvSdnn.length
      ? await caller.biometrics.importReferenceSamples({ side: sleeper, source: 'apple_watch', metric: 'hrv_sdnn', samples: hrvSdnn })
      : { written: 0 }
    let stages = 0
    let stageError: string | null = null
    if (segments.length) {
      try {
        stages = (await caller.biometrics.importReferenceStages({ side: sleeper, source: 'apple_watch', segments })).written
      }
      catch (error) {
        stageError = error instanceof TRPCError && error.code === 'BAD_REQUEST'
          ? `Stage import failed: ${error.message}`
          : 'Stage import failed; stored stages were preserved. Check segment bounds/overlaps before retrying. See the vitals count for imported heart-rate samples.'
      }
    }
    return jsonResult({ vitals: vitals.written, breathing: breathing.written, hrv: hrv.written, stages, stageError })
  }))

  server.registerTool('get_sleep_summary', {
    title: 'Summarize a night of sleep',
    description:
      'Last night (or a chosen sleep record) for one side: bed entry and exit times, time in bed, exits, '
      + 'sleep-stage distribution and blocks, average/min/max heart rate, HRV and breathing rate, and '
      + 'restlessness. Use for "how did I sleep", "what was my resting heart rate last night". '
      + 'Vitals fields are null when the sensor could not get a reliable reading. referenceAgreement compares the '
      + 'pod\'s stages with imported Apple Watch stages for the same night (null without any).',
    inputSchema: {
      side,
      sleepRecordId: z.number().int().positive().optional()
        .describe('A specific sleep record id from get_sleep_history. Omit for the most recent night.'),
    },
    annotations: READ_ONLY,
  }, async ({ side: s, sleepRecordId }) => runTool(async () => {
    const caller = getCaller()
    if (sleepRecordId !== undefined) {
      const found = await caller.biometrics.getSleepRecord({ id: sleepRecordId })
      if (!found || found.side !== s) {
        throw new Error(`Sleep record ${sleepRecordId} not found for the ${s} side. Use get_sleep_history to list valid ids.`)
      }
      return jsonResult(await summarize(found))
    }
    const latest = await caller.biometrics.getLatestSleep({ side: s })
    if (!latest) return jsonResult({ side: s, record: null, message: 'No sleep records for this side yet.' })
    return jsonResult(await summarize(latest))
  }))

  server.registerTool('get_sleep_history', {
    title: 'List recent nights',
    description:
      'Sleep records for the last N days (default 7), newest first, for one or both sides: entry/exit times, '
      + 'duration and exits per night. Use for trends like "how consistent has my bedtime been", or to find a '
      + 'sleepRecordId for get_sleep_summary.',
    inputSchema: { side: optionalSide, days, limit: z.number().int().min(1).max(100).default(14) },
    annotations: READ_ONLY,
  }, async ({ side: s, days: d, limit }) => runTool(async () => {
    const endDate = new Date()
    const startDate = new Date(endDate.getTime() - (d ?? 7) * DAY_MS)
    const records = await getCaller().biometrics.getSleepRecords({ side: s, startDate, endDate, limit })
    return jsonResult(records.map(r => ({
      id: r.id,
      side: r.side,
      enteredBedAt: r.enteredBedAt,
      leftBedAt: r.leftBedAt,
      sleepDurationSeconds: r.sleepDurationSeconds,
      timesExitedBed: r.timesExitedBed,
    })))
  }))

  server.registerTool('get_vitals_trend', {
    title: 'Vitals trend vs baseline',
    description:
      'Heart rate, HRV and breathing rate for one side: the multi-day baseline (mean and standard deviation) '
      + 'and the summary for a recent window, so you can say whether last night was unusual. Default baseline '
      + 'is 30 days and the recent window is 7 days; pass startDate and/or endDate to summarize a specific period '
      + '(a missing startDate means 7 days before endDate; a missing endDate means now).',
    inputSchema: { side, baselineDays: days, startDate: isoDate, endDate: isoDate },
    annotations: READ_ONLY,
  }, async ({ side: s, baselineDays, startDate, endDate }) => runTool(async () => {
    const caller = getCaller()
    const [baseline, recent] = await Promise.all([
      caller.biometrics.getVitalsBaseline({ side: s, days: baselineDays ?? 30 }),
      caller.biometrics.getVitalsSummary({
        side: s,
        ...(startDate && { startDate: new Date(startDate) }),
        ...(endDate && { endDate: new Date(endDate) }),
      }),
    ])
    return jsonResult({ side: s, baseline, recent })
  }))

  server.registerTool('get_sleep_stage_rules', {
    title: 'Sleep stage rules and reference coverage',
    description:
      'How one or both sides classify sleep stages: the saved classifier (ruleset with indexed rules and conditions; '
      + 'nights with piezo calibration quality below lowSignalBelow use lowSignalRules instead of rules), '
      + 'whether it is the default, the available preset ids, recent changes (each with the ruleset before it, for rollback, '
      + 'and accuracy before/after on the latest night), '
      + 'and reference coverage: how many of '
      + `the last ${COVERAGE_DAYS} nights have Apple Watch stages, how many reference epochs, the latest reference date, and how well `
      + 'the pod\'s heart-rate estimate tracks the watch (heartRateAgreement). A weak correlation there means HR-ratio rules '
      + 'cannot separate stages and tuning their thresholds is pointless; try the hrvFirst preset instead. '
      + 'Read this before preview_sleep_stage_rules or set_sleep_stage_rules; a side with zero coverage cannot be scored.',
    inputSchema: { side: optionalSide },
    annotations: READ_ONLY,
  }, async ({ side: s }) => runTool(async () => {
    const sides = s ? [s] : (['left', 'right'] as const)
    const result = await Promise.all(sides.map(async (sleeper) => {
      const [rules, coverage] = await Promise.all([getCaller().sleepStages.getClassifier({ side: sleeper }), referenceCoverage(sleeper)])
      return {
        side: sleeper,
        classifier: rules.classifier,
        isDefault: rules.isDefault,
        presets: rules.presets.map(p => ({ id: p.id, label: p.label, description: p.description })),
        recentChanges: rules.changes.slice(0, 5).map(changeView),
        referenceCoverage: coverage,
        hint: coverage.nights === 0
          ? IMPORT_HINT
          : coverage.truncated
            ? 'Coverage queries hit their row cap: counts are lower bounds and latestReferenceAt may be stale (oldest rows are kept).'
            : coverage.heartRateAgreement && coverage.heartRateAgreement.correlation < HR_WEAK_CORRELATION
              ? `Pod heart rate correlates only ${coverage.heartRateAgreement.correlation.toFixed(2)} with the watch, so hrRatio rules classify noise. Preview the hrvFirst preset or HRV-based overrides; fixing heart-rate extraction matters more than thresholds.`
              : null,
      }
    }))
    return jsonResult(s ? result[0] : result)
  }))

  server.registerTool('preview_sleep_stage_rules', {
    title: 'Dry-run a candidate sleep stage ruleset',
    description:
      'Dry run only: scores a candidate ruleset against the side\'s recent nights without saving anything. Give exactly one '
      + 'of presetId, ruleset, or overrides. Returns the saved and candidate agreement with Apple Watch reference stages '
      + '(accuracy, kappa, confusion matrix, per-stage recall), mean minutes per stage per night, and how many epochs of the '
      + 'latest night change stage. Judge a candidate by kappa, not accuracy alone: a ruleset that predicts one stage everywhere '
      + 'can score high accuracy with kappa near 0. Agreement is null when the nights have no reference stages. '
      + 'To apply the winner, pass the returned candidateRuleset to set_sleep_stage_rules as ruleset: overrides are '
      + 're-resolved against whatever is saved at that moment, so the exact previewed ruleset is the safe thing to save.',
    inputSchema: {
      side,
      nights: z.number().int().min(1).max(14).default(7).describe('How many recent nights to score (1-14, default 7).'),
      presetId,
      ruleset,
      overrides,
    },
    annotations: READ_ONLY,
  }, async ({ side: s, nights, presetId: preset, ruleset: full, overrides: changes }) => runTool(async () => {
    const candidate = await resolveCandidate(s, { presetId: preset, ruleset: full, overrides: changes })
    if (candidate.classifier === null) throw new Error('Give exactly one of presetId, ruleset, or overrides.')
    const preview = await getCaller().sleepStages.previewClassifier({ side: s, nights, classifier: candidate.classifier })
    const saved = preview.saved
    const cand = preview.candidate
    return jsonResult({
      side: s,
      dryRun: true,
      candidateSource: candidate.source,
      candidateRuleset: candidate.classifier.ruleset,
      nights: preview.nights,
      hasReference: preview.hasReference,
      hint: preview.nights === 0
        ? 'No sleep records for this side yet.'
        : !preview.hasReference
            ? IMPORT_HINT
            : saved?.agreement || cand?.agreement ? null : UNCOVERED_HINT,
      saved: saved && { agreement: agreementView(saved.agreement), stageMinutesPerNight: minutes(saved.durations) },
      candidate: cand && { agreement: agreementView(cand.agreement), stageMinutesPerNight: minutes(cand.durations) },
      kappaDelta: saved?.agreement?.kappa != null && cand?.agreement?.kappa != null ? cand.agreement.kappa - saved.agreement.kappa : null,
      epochsChanged: preview.changed?.changed ?? 0,
      epochsTotal: preview.changed?.total ?? 0,
      apply: 'Call set_sleep_stage_rules with ruleset: candidateRuleset to save exactly this candidate.',
    })
  }))

  server.registerTool('compare_vitals_to_watch', {
    title: 'Pod vs Apple Watch deviation report',
    description:
      'Read-only: how far the pod\'s heart rate, breathing rate, HRV and sleep stages sit from imported Apple Watch data, per night '
      + 'and as a summary pooled over every pair of all nights. Deviation is pod − Watch: per metric n, watchSamples, coverage '
      + '(paired / Watch samples), mae, bias (positive = pod reads high), p90 absolute error and Pearson r, all null without data. '
      + `Pairing: HR nearest pod reading within ±${WATCH_PAIRING_WINDOW_MS.heartRate / 1000} s (as get_sleep_stage_rules' heartRateAgreement), `
      + `breathing within ±${WATCH_PAIRING_WINDOW_MS.breathingRate / 1000} s, HRV = mean pod HRV within ±${WATCH_PAIRING_WINDOW_MS.hrv / 60_000} min vs Watch SDNN `
      + '(not like-for-like yet; see hrvNote). Stages re-run the side\'s current classifier on stored vitals and report epochs, accuracy, '
      + 'kappa, per-stage recall and pod vs Watch minutes. The goal is near-zero deviation: lower mae and |bias|, higher r, coverage and kappa. '
      + 'Use it before and after any biometric profile change (apply_biometric_profile) or stage ruleset change (set_sleep_stage_rules) '
      + 'to see whether deviation went down. Stages re-score immediately; stored HR, breathing and HRV only change for nights recorded '
      + 'after a profile takes effect, so compare those nights; configChanges lists the profile generations that took effect in the '
      + 'window (generation, atMs = the sample time the processor acknowledged) to tell which nights those are. '
      + 'Nights are picked by bed-entry time; a date-only startDate/endDate is '
      + 'a whole UTC calendar day, so endDate "2026-10-18" includes records entered any time that day. Default window is the last 14 days '
      + '(at most 31); only sleep records of at least minHours count.',
    inputSchema: {
      side,
      startDate: isoDate,
      endDate: isoDate,
      minHours: z.number().min(0).max(24).default(3).describe('Shortest sleep record that counts as a night, in hours (default 3).'),
    },
    annotations: READ_ONLY,
  }, async ({ side: s, startDate, endDate, minHours }) => runTool(async () => {
    const report = await getCaller().biometrics.compareToWatch({
      side: s,
      minHours,
      ...(startDate && { startDate: new Date(startDate) }),
      ...(endDate && { endDate: endOfDateOnly(endDate) }),
    })
    const { summary } = report
    const hasWatch = summary.heartRate.watchSamples + summary.breathingRate.watchSamples + summary.hrv.watchSamples > 0 || summary.stages !== null
    return jsonResult({
      ...report,
      hint: report.nights.length === 0
        ? `No sleep records of at least ${minHours} h in this window. Widen startDate/endDate or lower minHours.`
        : hasWatch
          ? null
          : 'No Apple Watch data overlaps these nights. Run import_apple_watch_data (or POST /api/biometrics/watch-upload) first.',
    })
  }))

  server.registerTool('set_sleep_stage_rules', {
    title: 'Save a sleep stage ruleset',
    description:
      'Save the side\'s sleep stage classifier. Give exactly one of presetId, ruleset, overrides, or reset: true (back to the '
      + 'defaults). Run preview_sleep_stage_rules first and apply only when the candidate improves kappa against the reference '
      + 'stages, not accuracy alone; prefer passing its candidateRuleset as ruleset, since overrides are re-resolved against the '
      + 'rules saved at save time. A user-requested reset or rollback does not need to improve kappa. Every change is recorded '
      + 'in the change log (summary, the ruleset before, and accuracy before and after on the latest night; a no-op save is not '
      + 'logged) and can be reverted by saving that previous ruleset again (before: null means reset: true). '
      + 'Stages are classified on read, so every stored '
      + 'night re-scores with the new rules. A CONFLICT means another save landed first: call get_sleep_stage_rules and retry.',
    inputSchema: {
      side,
      presetId,
      ruleset,
      overrides,
      reset: z.boolean().optional().describe('true to clear the custom ruleset and use the defaults.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ side: s, presetId: preset, ruleset: full, overrides: changes, reset }) => runTool(async () => {
    const candidate = await resolveCandidate(s, { presetId: preset, ruleset: full, overrides: changes, reset })
    if (candidate.classifier === null && !reset) throw new Error('Give exactly one of presetId, ruleset, overrides, or reset: true.')
    const caller = getCaller()
    const lastChangeId = candidate.current.changes[0]?.id ?? null
    let saved
    try {
      saved = await caller.sleepStages.setClassifier({ side: s, classifier: candidate.classifier })
    }
    catch (error) {
      if (error instanceof TRPCError && error.code === 'CONFLICT') {
        throw new Error(`CONFLICT (retryable): ${error.message}. Call get_sleep_stage_rules, re-check the candidate, and call set_sleep_stage_rules again.`)
      }
      throw error
    }
    const after = await caller.sleepStages.getClassifier({ side: s })
    const latest = after.changes[0]
    // Another save can land between setClassifier and this read; only trust the
    // newest entry when the stored classifier is still the one we sent.
    const stillOurs = JSON.stringify(after.classifier) === JSON.stringify(saved.classifier)
    const change = latest && latest.id !== lastChangeId && stillOurs ? changeView(latest) : null
    return jsonResult({
      side: s,
      candidateSource: candidate.source,
      classifier: saved.classifier,
      isDefault: saved.isDefault,
      change,
      message: change
        ? `Saved: ${change.summary}`
        : stillOurs
          ? 'No change: the side already used this ruleset.'
          : 'Saved, but another save landed right after; call get_sleep_stage_rules to see the current ruleset and change log.',
    })
  }))

  server.registerTool('get_bed_occupancy', {
    title: 'Who is in bed',
    description: 'Whether each side is currently occupied, from live capacitive and movement sensing.',
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => runTool(async () => jsonResult(await getCaller().biometrics.getOccupancy())))
}

type SleepRecord = NonNullable<Awaited<ReturnType<ReturnType<typeof getCaller>['biometrics']['getLatestSleep']>>>

async function summarize(record: SleepRecord) {
  const caller = getCaller()
  const startDate = record.enteredBedAt
  const endDate = record.leftBedAt ?? new Date()
  const [stages, vitals, movement, reference] = await Promise.all([
    caller.biometrics.getSleepStages({ side: record.side, sleepRecordId: record.id }),
    caller.biometrics.getVitalsSummary({ side: record.side, startDate, endDate }),
    caller.biometrics.getMovementSummary({ side: record.side, startDate, endDate }),
    caller.biometrics.getReferenceStages({ side: record.side, startDate, endDate, limit: 20000 }),
  ])
  const agreement = reference.length
    ? scoreAgainstReference(stages.epochs, reference.map(r => ({ start: r.start.getTime(), end: r.end.getTime(), stage: r.stage })))
    : null
  return {
    side: record.side,
    record: {
      id: record.id,
      enteredBedAt: record.enteredBedAt,
      leftBedAt: record.leftBedAt,
      inBed: record.leftBedAt === null,
      sleepDurationSeconds: record.sleepDurationSeconds,
      timesExitedBed: record.timesExitedBed,
    },
    stages: { distribution: stages.distribution, blocks: stages.blocks },
    referenceAgreement: agreement && { source: reference[0].source, ...agreementView(agreement) },
    referenceHint: agreement
      ? null
      : reference.length
        ? 'Reference stages exist for this night but cover none of the pod\'s epochs.'
        : 'No reference stages for this night. Run import_apple_watch_data to compare against Apple Watch.',
    vitals,
    movement,
  }
}

type ChangeEntry = Awaited<ReturnType<Caller['sleepStages']['getClassifier']>>['changes'][number]

/** Change-log entry for the model: the agreement numbers are accuracy on the latest night, not kappa. */
function changeView(c: ChangeEntry) {
  return { id: c.id, changedAt: new Date(c.changedAt), summary: c.summary, before: c.before, accuracyBefore: c.agreementBefore, accuracyAfter: c.agreementAfter }
}

function agreementView(a: StageAgreement | null) {
  return a && { epochs: a.epochs, accuracy: a.accuracy, kappa: a.kappa, confusion: a.confusion, recall: a.recall }
}

function minutes(durations: Record<SleepStage, number>): Record<SleepStage, number> {
  return { wake: Math.round(durations.wake / 60_000), light: Math.round(durations.light / 60_000), deep: Math.round(durations.deep / 60_000), rem: Math.round(durations.rem / 60_000) }
}

/** Nights in the last COVERAGE_DAYS with reference stages, total reference epochs and the latest reference date. */
async function referenceCoverage(sleeper: 'left' | 'right') {
  const caller = getCaller()
  const endDate = new Date()
  const startDate = new Date(endDate.getTime() - COVERAGE_DAYS * DAY_MS)
  const [segments, records, watchHr] = await Promise.all([
    caller.biometrics.getReferenceStages({ side: sleeper, startDate, endDate, limit: SEGMENT_LIMIT }),
    caller.biometrics.getSleepRecords({ side: sleeper, startDate, endDate, limit: RECORD_LIMIT }),
    caller.biometrics.getReferenceVitals({ side: sleeper, startDate, endDate, limit: SEGMENT_LIMIT }),
  ])
  const podHr = watchHr.length ? await caller.biometrics.getVitals({ side: sleeper, startDate, endDate, limit: VITALS_LIMIT }) : []
  const overlaps = (r: { enteredBedAt: Date, leftBedAt: Date | null }) => {
    const end = r.leftBedAt ?? endDate
    return segments.some(seg => seg.start < end && seg.end > r.enteredBedAt)
  }
  // Segments may straddle the window; count only the part inside it.
  const coveredMs = segments.reduce((sum, seg) => sum + Math.max(0, Math.min(seg.end.getTime(), endDate.getTime()) - Math.max(seg.start.getTime(), startDate.getTime())), 0)
  const latest = segments.reduce<Date | null>((max, seg) => max && max > seg.end ? max : seg.end, null)
  return {
    days: COVERAGE_DAYS,
    nights: records.filter(overlaps).length,
    segments: segments.length,
    epochs: Math.round(coveredMs / EPOCH_MS),
    latestReferenceAt: latest,
    source: segments[0]?.source ?? null,
    /** True when either query hit its row cap, so the counts above are lower bounds. */
    truncated: segments.length >= SEGMENT_LIMIT || records.length >= RECORD_LIMIT,
    heartRateAgreement: heartRateAgreement(podHr, watchHr),
  }
}

/**
 * How well the pod's heart-rate estimate tracks the watch: Pearson correlation
 * and mean absolute error, pairing each watch sample with the nearest pod
 * reading the way compare_vitals_to_watch does (WATCH_PAIRING_WINDOW_MS). Null
 * without enough pairs. Stage rules on hrRatio only work when this is high.
 */
function heartRateAgreement(pod: { timestamp: Date, heartRate: number | null }[], watch: { timestamp: Date, heartRate: number }[]) {
  const podSeries = pod.map(v => ({ t: v.timestamp.getTime(), v: v.heartRate })).sort((a, b) => a.t - b.t)
  const pairs: [number, number][] = []
  for (const w of [...watch].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())) {
    const best = nearestWithin(podSeries, w.timestamp.getTime(), WATCH_PAIRING_WINDOW_MS.heartRate)
    if (best !== null) pairs.push([w.heartRate, best])
  }
  if (pairs.length < 10) return null
  const n = pairs.length
  const mw = pairs.reduce((s, [w]) => s + w, 0) / n
  const mp = pairs.reduce((s, [, p]) => s + p, 0) / n
  let cov = 0
  let vw = 0
  let vp = 0
  let abs = 0
  for (const [w, p] of pairs) {
    cov += (w - mw) * (p - mp)
    vw += (w - mw) ** 2
    vp += (p - mp) ** 2
    abs += Math.abs(w - p)
  }
  const denom = Math.sqrt(vw * vp)
  return {
    pairs: n,
    correlation: denom === 0 ? 0 : Math.round((cov / denom) * 1000) / 1000,
    meanAbsErrorBpm: Math.round((abs / n) * 10) / 10,
    watchMeanBpm: Math.round(mw * 10) / 10,
    podMeanBpm: Math.round(mp * 10) / 10,
  }
}

interface CandidateInput {
  presetId?: keyof typeof STAGE_RULESET_PRESETS
  ruleset?: StageRuleset
  overrides?: { list: 'rules' | 'lowSignalRules', ruleIndex: number, conditionIndex: number, value: number }[]
  reset?: boolean
}

/**
 * Turn presetId / ruleset / overrides / reset into the classifier to preview
 * or save. Exactly one may be given; the saved classifier is always loaded so
 * overrides have a base and the caller can detect a new change-log entry.
 */
async function resolveCandidate(sleeper: 'left' | 'right', input: CandidateInput) {
  const given = [input.presetId !== undefined, input.ruleset !== undefined, input.overrides !== undefined, input.reset === true].filter(Boolean).length
  if (given > 1) throw new Error('Give exactly one of presetId, ruleset, overrides, or reset: true, not several.')
  const current = await getCaller().sleepStages.getClassifier({ side: sleeper })
  let classifier: StageClassifier | null = null
  let source = 'none'
  if (input.presetId !== undefined) {
    classifier = { engine: 'rules', ruleset: STAGE_RULESET_PRESETS[input.presetId].ruleset }
    source = `preset:${input.presetId}`
  }
  else if (input.ruleset !== undefined) {
    classifier = { engine: 'rules', ruleset: input.ruleset }
    source = 'ruleset'
  }
  else if (input.overrides !== undefined) {
    const copy = (rs: StageRule[]) => rs.map(r => ({ ...r, when: r.when.map(c => ({ ...c })) }))
    const lists = { rules: copy(current.classifier.ruleset.rules), lowSignalRules: copy(current.classifier.ruleset.lowSignalRules) }
    for (const o of input.overrides) {
      const condition = lists[o.list][o.ruleIndex]?.when[o.conditionIndex]
      if (!condition) {
        throw new Error(`No condition at ${o.list}[${o.ruleIndex}].when[${o.conditionIndex}] in the saved ruleset; call get_sleep_stage_rules for the current indexes.`)
      }
      condition.value = o.value
    }
    classifier = { engine: 'rules', ruleset: { ...current.classifier.ruleset, ...lists } }
    source = `overrides:${input.overrides.length}`
  }
  else if (input.reset) {
    source = 'reset'
  }
  return { classifier, source, current }
}
