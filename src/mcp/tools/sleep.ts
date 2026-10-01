/**
 * Sleep and vitals tools. Everything here reads the biometrics database.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getCaller, jsonResult, runTool } from '../caller'
import { days, isoDate, optionalSide, side } from '../schemas'

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
    let record = sleepRecordId
      ? (await caller.biometrics.getSleepRecords({ side: s, limit: 100 })).find(r => r.id === sleepRecordId) ?? null
      : await caller.biometrics.getLatestSleep({ side: s })
    if (!record) return jsonResult({ side: s, record: null, message: 'No sleep records for this side yet.' })
    record = { ...record }
    const startDate = record.enteredBedAt
    const endDate = record.leftBedAt ?? new Date()
    const [stages, vitals, movement] = await Promise.all([
      caller.biometrics.getSleepStages({ side: s, sleepRecordId: record.id }),
      caller.biometrics.getVitalsSummary({ side: s, startDate, endDate }),
      caller.biometrics.getMovementSummary({ side: s, startDate, endDate }),
    ])
    return jsonResult({
      side: s,
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
    })
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
      + 'is 30 days and the recent window is 7 days; pass startDate/endDate to summarize a specific period.',
    inputSchema: { side, baselineDays: days, startDate: isoDate, endDate: isoDate },
    annotations: READ_ONLY,
  }, async ({ side: s, baselineDays, startDate, endDate }) => runTool(async () => {
    const caller = getCaller()
    const range = startDate && endDate ? { startDate: new Date(startDate), endDate: new Date(endDate) } : {}
    const [baseline, recent] = await Promise.all([
      caller.biometrics.getVitalsBaseline({ side: s, days: baselineDays ?? 30 }),
      caller.biometrics.getVitalsSummary({ side: s, ...range }),
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
