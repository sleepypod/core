import type { DatasetSnapshot } from '@/src/biometrics/backtest/contracts'

/** A stage needs this many breathing values in a night before the night counts. */
export const MINIMUM_PER_STAGE = 5

type Labelled = 'rem' | 'light'
interface StageInterval { startMs: number, endMs: number, stage: string }
interface Value { timestampMs: number, value: number }

/** Scorable reference stage intervals overlapping [startMs, endMs), sorted. */
export function referenceStages(snapshot: DatasetSnapshot, startMs: number, endMs: number): StageInterval[] {
  return snapshot.references.flatMap(reference => reference.measurements)
    .filter(row => row.metric === 'sleep_stages' && row.scorable && row.stage !== null && row.temporalKind === 'interval' && row.startMs < endMs && row.endMs > startMs)
    .map(row => ({ startMs: row.startMs, endMs: row.endMs, stage: row.stage as string }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
}

/** Scorable reference breathing-rate values in [startMs, endMs). */
export function referenceBreathing(snapshot: DatasetSnapshot, startMs: number, endMs: number): Value[] {
  return snapshot.references.flatMap(reference => reference.measurements)
    .filter(row => row.metric === 'breathing_rate' && row.scorable && row.value !== null && row.startMs >= startMs && row.startMs < endMs)
    .map(row => ({ timestampMs: row.startMs, value: row.value as number }))
}

/** The stage covering a time, or null when none does or overlapping imports disagree. */
function stageAt(intervals: StageInterval[], timestampMs: number) {
  let found: string | null = null
  for (const interval of intervals) {
    if (interval.startMs > timestampMs) break
    if (timestampMs >= interval.endMs) continue
    if (found !== null && found !== interval.stage) return null
    found = interval.stage
  }
  return found
}

/**
 * REM minus light breathing rate, in pooled within-night SD. Each night's
 * difference of stage means is averaged with equal night weight; the SD pools
 * each stage's spread around its own night mean, so a night that runs high
 * overall doesn't widen it. Nights without MINIMUM_PER_STAGE values in both
 * stages are left out.
 */
export function remLightSeparation(nights: Array<{ values: Value[], stages: StageInterval[] }>) {
  let squares = 0, freedom = 0, rem = 0, light = 0
  const differences: number[] = []
  for (const night of nights) {
    const groups: Record<Labelled, number[]> = { rem: [], light: [] }
    for (const row of night.values) {
      const stage = stageAt(night.stages, row.timestampMs)
      if (stage === 'rem' || stage === 'light') groups[stage].push(row.value)
    }
    if (groups.rem.length < MINIMUM_PER_STAGE || groups.light.length < MINIMUM_PER_STAGE) continue
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
    const means = { rem: mean(groups.rem), light: mean(groups.light) }
    for (const stage of ['rem', 'light'] as const) squares += groups[stage].reduce((sum, value) => sum + (value - means[stage]) ** 2, 0)
    freedom += groups.rem.length + groups.light.length - 2
    rem += groups.rem.length
    light += groups.light.length
    differences.push(means.rem - means.light)
  }
  if (!differences.length) return { status: 'no_paired_reference' as const, nights: 0, remValues: 0, lightValues: 0, meanDifference: null, pooledSd: null, standardized: null }
  const meanDifference = differences.reduce((sum, value) => sum + value, 0) / differences.length
  const pooledSd = Math.sqrt(squares / freedom)
  return { status: 'scored' as const, nights: differences.length, remValues: rem, lightValues: light, meanDifference, pooledSd,
    standardized: pooledSd > 0 ? meanDifference / pooledSd : null }
}
export type RemLightSeparation = ReturnType<typeof remLightSeparation>
