/**
 * Sleep and vitals tools. Everything here reads the biometrics database.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getCaller, jsonResult, runTool } from '@/src/mcp/caller'
import { days, isoDate, optionalSide, side } from '@/src/mcp/schemas'

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

const DAY_MS = 24 * 60 * 60 * 1000

export function registerSleepTools(server: McpServer) {
  server.registerTool('get_sleep_summary', {
    title: 'Summarize a night of sleep',
    description:
      'Last night (or a chosen sleep record) for one side: bed entry and exit times, time in bed, exits, '
      + 'sleep-stage distribution and blocks, average/min/max heart rate, HRV and breathing rate, and '
      + 'restlessness. Use for "how did I sleep", "what was my resting heart rate last night". '
      + 'Vitals fields are null when the sensor could not get a reliable reading.',
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
  const [stages, vitals, movement] = await Promise.all([
    caller.biometrics.getSleepStages({ side: record.side, sleepRecordId: record.id }),
    caller.biometrics.getVitalsSummary({ side: record.side, startDate, endDate }),
    caller.biometrics.getMovementSummary({ side: record.side, startDate, endDate }),
  ])
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
    vitals,
    movement,
  }
}
