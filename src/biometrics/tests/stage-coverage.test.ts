import { describe, expect, it } from 'vitest'
import { stageNight } from '../stage-night'
import { stagesWithinWindow } from '@/src/lib/stage-coverage'
import { classifyNights, mergeIntoBlocks, type SleepEpoch } from '@/src/lib/sleep-stages'
import { DEFAULT_STAGE_RULESET } from '@/src/lib/sleep-stage-rules'

const epoch = (start: number, duration: number, stage: SleepEpoch['stage'] = 'light'): SleepEpoch =>
  ({ start, duration, stage, heartRate: 60, hrv: 30, breathingRate: 14, movement: null })
const window = { start: new Date(100_000), end: new Date(600_000) }

describe('recording stage coverage', () => {
  it('clips both ends, removes invalid epochs and prevents duplicate or overlapping time', () => {
    const result = stagesWithinWindow([
      epoch(0, 200_000), epoch(200_000, 300_000), epoch(300_000, 300_000),
      epoch(300_000, 200_000), epoch(550_000, 300_000), epoch(700_000, 100), epoch(NaN, 100),
    ], window)
    expect(result.map(({ start, duration }) => [start, duration])).toEqual([
      [100_000, 100_000], [200_000, 100_000], [300_000, 200_000], [550_000, 50_000],
    ])
    expect(result.reduce((total, entry) => total + entry.duration, 0)).toBe(450_000)
  })
  it('does not turn a sensor outage into an uninterrupted stage block', () => {
    const result = mergeIntoBlocks([epoch(0, 60_000), epoch(60_000, 60_000), epoch(600_000, 60_000)])
    expect(result).toEqual([{ start: 0, end: 120_000, stage: 'light' }, { start: 600_000, end: 660_000, stage: 'light' }])
  })
  it('clips the real rules classifier final five-minute estimate to the requested end', () => {
    const result = stageNight([{ timestamp: new Date(550_000), heartRate: 60,
      hrv: 30, breathingRate: 14 }], [], 1, DEFAULT_STAGE_RULESET, null, window)
    expect(result.epochs).toHaveLength(1)
    expect(result.epochs[0]).toMatchObject({ start: 550_000, duration: 50_000 })
    expect(result.stagedBy.engine).toBe('rules')
  })
  it('uses the same recording boundary for rule previews and agreement', () => {
    const result = classifyNights([{ window, vitalsData: [{ timestamp: new Date(550_000), heartRate: 60, hrv: 30, breathingRate: 14 }],
      movementData: [], calibrationQuality: 1, reference: [] }], DEFAULT_STAGE_RULESET)
    expect(result?.latestEpochs[0].duration).toBe(50_000)
    expect(result?.summary.totalSleepMs).toBe(50_000)
    expect(result?.summary.blocks[0].end).toBe(600_000)
  })
  it('rejects reversed and invalid windows', () => {
    expect(stagesWithinWindow([epoch(0, 300_000)], { start: new Date(5), end: new Date(4) })).toEqual([])
    expect(stagesWithinWindow([epoch(0, 300_000)], { start: new Date(NaN), end: new Date(4) })).toEqual([])
  })
})
