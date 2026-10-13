/**
 * Sleep and vitals tools, including imports into the reference biometrics tables.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { getCaller, jsonResult, runTool } from '@/src/mcp/caller'
import { days, isoDate, optionalSide, side } from '@/src/mcp/schemas'
import { STAGE_RULESET_PRESETS, stageRulesetSchema, type StageClassifier, type StageRuleset } from '@/src/lib/sleep-stage-rules'
import { scoreAgainstReference, type SleepStage, type StageAgreement } from '@/src/lib/sleep-stages'

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

const DAY_MS = 24 * 60 * 60 * 1000
const EPOCH_MS = 5 * 60 * 1000
const COVERAGE_DAYS = 14
const SEGMENT_LIMIT = 20000
const RECORD_LIMIT = 100

const PRESET_IDS = Object.keys(STAGE_RULESET_PRESETS) as [keyof typeof STAGE_RULESET_PRESETS, ...(keyof typeof STAGE_RULESET_PRESETS)[]]

const IMPORT_HINT = 'No reference stages for this side. Run import_apple_watch_data (or POST /api/biometrics/watch-upload) first; a side without reference coverage cannot be scored.'

const presetId = z.enum(PRESET_IDS).optional()
  .describe(`A built-in ruleset preset: ${PRESET_IDS.join(', ')}. Ids come from get_sleep_stage_rules.`)
const ruleset = stageRulesetSchema.optional()
  .describe('A complete ruleset, as returned by get_sleep_stage_rules under classifier.ruleset.')
const overrides = z.array(z.object({
  ruleIndex: z.number().int().min(0).describe('Index into the saved classifier\'s rules array.'),
  conditionIndex: z.number().int().min(0).describe('Index into that rule\'s when array.'),
  value: z.number().finite().describe('New threshold for that condition, in the metric\'s unit.'),
})).min(1).max(32).optional()
  .describe('Threshold changes applied to the side\'s saved rules. Everything else in the ruleset stays as saved.')

export function registerSleepTools(server: McpServer) {
  server.registerTool('import_apple_watch_data', {
    title: 'Import Apple Watch heart rate and sleep stages',
    description: 'Sync extracted Apple Health records to one sleeper. Send at most 2000 samples/segments per call; repeat calls are safe. '
      + 'For a complete export.zip or export.xml, stream the file with POST /api/biometrics/watch-upload?side=left|right&days=30 '
      + '(application/octet-stream, 512 MiB maximum, days 1..90) instead of placing the export in model context. '
      + 'Stage conflicts are reported without blocking heart-rate import. Records remain separate from pod measurements.',
    inputSchema: {
      side,
      samples: z.array(z.object({ timestamp: z.number().int().min(1_000_000_000).max(4_102_444_800), heartRate: z.number().min(20).max(250) })).max(2000).default([]),
      segments: z.array(z.object({ start: z.number().int().min(1_000_000_000).max(4_102_444_800), end: z.number().int().min(1_000_000_000).max(4_102_444_800), stage: z.enum(['wake', 'light', 'deep', 'rem']) })).max(2000).default([]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ side: sleeper, samples, segments }) => runTool(async () => {
    if (!samples.length && !segments.length) throw new Error('Provide samples or segments. Timestamps are Unix seconds.')
    const caller = getCaller()
    const vitals = samples.length ? await caller.biometrics.importReferenceVitals({ side: sleeper, source: 'apple_watch', samples }) : { written: 0 }
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
    return jsonResult({ vitals: vitals.written, stages, stageError })
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
      'How one or both sides classify sleep stages: the saved classifier (ruleset with indexed rules and conditions), '
      + 'whether it is the default, the available preset ids, recent changes, and reference coverage: how many of '
      + `the last ${COVERAGE_DAYS} nights have Apple Watch stages, how many reference epochs, and the latest reference date. `
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
        recentChanges: rules.changes.slice(0, 5).map(c => ({ id: c.id, changedAt: new Date(c.changedAt), summary: c.summary, agreementBefore: c.agreementBefore, agreementAfter: c.agreementAfter })),
        referenceCoverage: coverage,
        hint: coverage.nights === 0 ? IMPORT_HINT : null,
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
      + 'To apply the winner, call set_sleep_stage_rules with the same arguments.',
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
      nights: preview.nights,
      hasReference: preview.hasReference,
      hint: preview.nights === 0 ? 'No sleep records for this side yet.' : preview.hasReference ? null : IMPORT_HINT,
      saved: saved && { agreement: agreementView(saved.agreement), stageMinutesPerNight: minutes(saved.durations) },
      candidate: cand && { agreement: agreementView(cand.agreement), stageMinutesPerNight: minutes(cand.durations) },
      kappaDelta: saved?.agreement?.kappa != null && cand?.agreement?.kappa != null ? cand.agreement.kappa - saved.agreement.kappa : null,
      epochsChanged: preview.changed?.changed ?? 0,
      epochsTotal: preview.changed?.total ?? 0,
      apply: 'Call set_sleep_stage_rules with the same presetId/ruleset/overrides to save this candidate.',
    })
  }))

  server.registerTool('set_sleep_stage_rules', {
    title: 'Save a sleep stage ruleset',
    description:
      'Save the side\'s sleep stage classifier. Give exactly one of presetId, ruleset, overrides, or reset: true (back to the '
      + 'defaults). Run preview_sleep_stage_rules first and apply only when the candidate improves kappa against the reference '
      + 'stages, not accuracy alone. Every save is recorded in the change log (summary plus agreement before and after on the '
      + 'latest night) and can be reverted by saving the previous ruleset again. Stages are classified on read, so every stored '
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
    const change = latest && latest.id !== lastChangeId
      ? { id: latest.id, changedAt: new Date(latest.changedAt), summary: latest.summary, agreementBefore: latest.agreementBefore, agreementAfter: latest.agreementAfter }
      : null
    return jsonResult({
      side: s,
      candidateSource: candidate.source,
      classifier: saved.classifier,
      isDefault: saved.isDefault,
      change,
      message: change ? `Saved: ${change.summary}` : 'No change: the side already used this ruleset.',
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
  const [segments, records] = await Promise.all([
    caller.biometrics.getReferenceStages({ side: sleeper, startDate, endDate, limit: SEGMENT_LIMIT }),
    caller.biometrics.getSleepRecords({ side: sleeper, startDate, endDate, limit: RECORD_LIMIT }),
  ])
  const overlaps = (r: { enteredBedAt: Date, leftBedAt: Date | null }) => {
    const end = r.leftBedAt ?? endDate
    return segments.some(seg => seg.start < end && seg.end > r.enteredBedAt)
  }
  const coveredMs = segments.reduce((sum, seg) => sum + (seg.end.getTime() - seg.start.getTime()), 0)
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
  }
}

interface CandidateInput {
  presetId?: keyof typeof STAGE_RULESET_PRESETS
  ruleset?: StageRuleset
  overrides?: { ruleIndex: number, conditionIndex: number, value: number }[]
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
    const rules = current.classifier.ruleset.rules.map(r => ({ ...r, when: r.when.map(c => ({ ...c })) }))
    for (const o of input.overrides) {
      const condition = rules[o.ruleIndex]?.when[o.conditionIndex]
      if (!condition) {
        throw new Error(`No condition at rules[${o.ruleIndex}].when[${o.conditionIndex}] in the saved ruleset; call get_sleep_stage_rules for the current indexes.`)
      }
      condition.value = o.value
    }
    classifier = { engine: 'rules', ruleset: { ...current.classifier.ruleset, rules } }
    source = `overrides:${input.overrides.length}`
  }
  else if (input.reset) {
    source = 'reset'
  }
  return { classifier, source, current }
}
