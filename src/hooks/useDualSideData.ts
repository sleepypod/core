'use client'

import { useMemo } from 'react'
import { trpc } from '@/src/utils/trpc'
import { useSide, type Side } from '@/src/providers/SideProvider'

// ── Labeled types: every record gets a `side` tag for chart/display use ──

export interface LabeledVital {
  side: Side
  id: number
  timestamp: Date
  heartRate: number | null
  hrv: number | null
  breathingRate: number | null
}

export interface LabeledSleepRecord {
  side: Side
  id: number
  enteredBedAt: Date
  leftBedAt: Date
  sleepDurationSeconds: number
  timesExitedBed: number
  presentIntervals: unknown
  notPresentIntervals: unknown
  createdAt: Date
}

export interface LabeledMovement {
  side: Side
  id: number
  timestamp: Date
  totalMovement: number
}

export interface VitalsSummary {
  side: Side
  avgHeartRate: number | null
  minHeartRate: number | null
  maxHeartRate: number | null
  avgHRV: number | null
  avgBreathingRate: number | null
  recordCount: number
}

export interface SleepStageBlock {
  stage: string
  startMs: number
  endMs: number
  durationMs: number
}

export interface SleepStageDistribution {
  wake: number
  light: number
  deep: number
  rem: number
}

export interface LabeledSleepStages {
  side: Side
  epochs: Array<{ timestamp: number; stage: string; duration: number }>
  blocks: SleepStageBlock[]
  distribution: SleepStageDistribution
  qualityScore: number
  totalSleepMs: number
  sleepRecordId: number | null
  enteredBedAt: number | null
  leftBedAt: number | null
}

export interface DualSideDataset {
  /** Merged vitals from active sides, sorted by timestamp ascending */
  vitals: LabeledVital[]
  /** Merged sleep records from active sides, sorted by enteredBedAt descending */
  sleepRecords: LabeledSleepRecord[]
  /** Merged movement data from active sides, sorted by timestamp ascending */
  movement: LabeledMovement[]
  /** Per-side vitals summaries (one entry per active side) */
  vitalsSummaries: VitalsSummary[]
  /** Per-side sleep stages (one entry per active side) */
  sleepStages: LabeledSleepStages[]
  /** Which sides are currently active */
  activeSides: Side[]
  /** Whether any data is still loading */
  isLoading: boolean
  /** Whether any query has errored */
  isError: boolean
  /** Combined error messages */
  errors: string[]
  /** Refetch all queries */
  refetch: () => void
}

export interface UseDualSideDataOptions {
  /** Date range start (inclusive) */
  startDate?: Date
  /** Date range end (inclusive) */
  endDate?: Date
  /** Max vitals records per side (default: 288 = ~24hrs of 5min intervals) */
  vitalsLimit?: number
  /** Max sleep records per side (default: 7) */
  sleepLimit?: number
  /** Max movement records per side (default: 288) */
  movementLimit?: number
  /** Whether to fetch vitals data (default: true) */
  includeVitals?: boolean
  /** Whether to fetch sleep records (default: true) */
  includeSleep?: boolean
  /** Whether to fetch movement data (default: true) */
  includeMovement?: boolean
  /** Whether to fetch vitals summary (default: true) */
  includeVitalsSummary?: boolean
  /** Whether to fetch sleep stages (default: true) */
  includeSleepStages?: boolean
  /** Whether queries are enabled (default: true) */
  enabled?: boolean
}

/**
 * Dual-side data hook that fetches and merges biometric/sensor data
 * from both left and right sides into a unified dataset with side labels.
 *
 * When the global SideProvider is set to a single side ('left' or 'right'),
 * fetches data for that side only. When set to 'both', fetches from both
 * sides in parallel and merges with side labels for dual-side comparison.
 *
 * Usage:
 * ```tsx
 * const { vitals, sleepRecords, vitalsSummaries, isLoading } = useDualSideData({
 *   startDate: weekStart,
 *   endDate: weekEnd,
 * })
 *
 * // In 'both' mode, vitals contains interleaved left+right records
 * // Each record has a `side` field for rendering separate series
 * vitals.filter(v => v.side === 'left')  // left series
 * vitals.filter(v => v.side === 'right') // right series
 * ```
 */
export function useDualSideData(options: UseDualSideDataOptions = {}): DualSideDataset {
  const {
    startDate,
    endDate,
    vitalsLimit = 288,
    sleepLimit = 7,
    movementLimit = 288,
    includeVitals = true,
    includeSleep = true,
    includeMovement = true,
    includeVitalsSummary = true,
    includeSleepStages = true,
    enabled = true,
  } = options

  const { activeSides } = useSide()

  const hasLeft = activeSides.includes('left')
  const hasRight = activeSides.includes('right')

  // ── Vitals queries ──
  const leftVitals = trpc.biometrics.getVitals.useQuery(
    { side: 'left', startDate, endDate, limit: vitalsLimit },
    { enabled: enabled && includeVitals && hasLeft },
  )
  const rightVitals = trpc.biometrics.getVitals.useQuery(
    { side: 'right', startDate, endDate, limit: vitalsLimit },
    { enabled: enabled && includeVitals && hasRight },
  )

  // ── Sleep records queries ──
  const leftSleep = trpc.biometrics.getSleepRecords.useQuery(
    { side: 'left', startDate, endDate, limit: sleepLimit },
    { enabled: enabled && includeSleep && hasLeft },
  )
  const rightSleep = trpc.biometrics.getSleepRecords.useQuery(
    { side: 'right', startDate, endDate, limit: sleepLimit },
    { enabled: enabled && includeSleep && hasRight },
  )

  // ── Movement queries ──
  const leftMovement = trpc.biometrics.getMovement.useQuery(
    { side: 'left', startDate, endDate, limit: movementLimit },
    { enabled: enabled && includeMovement && hasLeft },
  )
  const rightMovement = trpc.biometrics.getMovement.useQuery(
    { side: 'right', startDate, endDate, limit: movementLimit },
    { enabled: enabled && includeMovement && hasRight },
  )

  // ── Vitals summary queries ──
  const leftVitalsSummary = trpc.biometrics.getVitalsSummary.useQuery(
    { side: 'left', startDate, endDate },
    { enabled: enabled && includeVitalsSummary && hasLeft },
  )
  const rightVitalsSummary = trpc.biometrics.getVitalsSummary.useQuery(
    { side: 'right', startDate, endDate },
    { enabled: enabled && includeVitalsSummary && hasRight },
  )

  // ── Sleep stages queries ──
  const leftStages = trpc.biometrics.getSleepStages.useQuery(
    { side: 'left', startDate, endDate },
    { enabled: enabled && includeSleepStages && hasLeft },
  )
  const rightStages = trpc.biometrics.getSleepStages.useQuery(
    { side: 'right', startDate, endDate },
    { enabled: enabled && includeSleepStages && hasRight },
  )

  // ── Merge vitals ──
  const mergedVitals = useMemo<LabeledVital[]>(() => {
    const left: LabeledVital[] = hasLeft && leftVitals.data
      ? (leftVitals.data as any[]).map(v => ({ ...v, side: 'left' as const }))
      : []
    const right: LabeledVital[] = hasRight && rightVitals.data
      ? (rightVitals.data as any[]).map(v => ({ ...v, side: 'right' as const }))
      : []
    return [...left, ...right].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    )
  }, [hasLeft, hasRight, leftVitals.data, rightVitals.data])

  // ── Merge sleep records ──
  const mergedSleep = useMemo<LabeledSleepRecord[]>(() => {
    const left: LabeledSleepRecord[] = hasLeft && leftSleep.data
      ? (leftSleep.data as any[]).map(r => ({ ...r, side: 'left' as const }))
      : []
    const right: LabeledSleepRecord[] = hasRight && rightSleep.data
      ? (rightSleep.data as any[]).map(r => ({ ...r, side: 'right' as const }))
      : []
    return [...left, ...right].sort(
      (a, b) => new Date(b.enteredBedAt).getTime() - new Date(a.enteredBedAt).getTime(),
    )
  }, [hasLeft, hasRight, leftSleep.data, rightSleep.data])

  // ── Merge movement ──
  const mergedMovement = useMemo<LabeledMovement[]>(() => {
    const left: LabeledMovement[] = hasLeft && leftMovement.data
      ? (leftMovement.data as any[]).map(m => ({ ...m, side: 'left' as const }))
      : []
    const right: LabeledMovement[] = hasRight && rightMovement.data
      ? (rightMovement.data as any[]).map(m => ({ ...m, side: 'right' as const }))
      : []
    return [...left, ...right].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    )
  }, [hasLeft, hasRight, leftMovement.data, rightMovement.data])

  // ── Vitals summaries (per-side array, not merged) ──
  const vitalsSummaries = useMemo<VitalsSummary[]>(() => {
    const summaries: VitalsSummary[] = []
    if (hasLeft && leftVitalsSummary.data) {
      summaries.push({ ...leftVitalsSummary.data, side: 'left' as const })
    }
    if (hasRight && rightVitalsSummary.data) {
      summaries.push({ ...rightVitalsSummary.data, side: 'right' as const })
    }
    return summaries
  }, [hasLeft, hasRight, leftVitalsSummary.data, rightVitalsSummary.data])

  // ── Sleep stages (per-side array, not merged) ──
  const sleepStages = useMemo<LabeledSleepStages[]>(() => {
    const stages: LabeledSleepStages[] = []
    if (hasLeft && leftStages.data) {
      stages.push({ ...(leftStages.data as any), side: 'left' as const })
    }
    if (hasRight && rightStages.data) {
      stages.push({ ...(rightStages.data as any), side: 'right' as const })
    }
    return stages
  }, [hasLeft, hasRight, leftStages.data, rightStages.data])

  // ── Loading / error aggregation ──
  const allQueries = [
    ...(includeVitals ? [leftVitals, rightVitals] : []),
    ...(includeSleep ? [leftSleep, rightSleep] : []),
    ...(includeMovement ? [leftMovement, rightMovement] : []),
    ...(includeVitalsSummary ? [leftVitalsSummary, rightVitalsSummary] : []),
    ...(includeSleepStages ? [leftStages, rightStages] : []),
  ]

  const isLoading = allQueries.some(q => q.isLoading && q.fetchStatus !== 'idle')
  const isError = allQueries.some(q => q.isError)
  const errors = allQueries
    .filter(q => q.error)
    .map(q => q.error!.message)

  const refetch = () => {
    allQueries.forEach(q => void q.refetch())
  }

  return {
    vitals: mergedVitals,
    sleepRecords: mergedSleep,
    movement: mergedMovement,
    vitalsSummaries,
    sleepStages,
    activeSides,
    isLoading,
    isError,
    errors,
    refetch,
  }
}

// ── Utility functions for working with dual-side datasets ──

/**
 * Filter a labeled dataset to a single side.
 */
export function filterBySide<T extends { side: Side }>(data: T[], side: Side): T[] {
  return data.filter(d => d.side === side)
}

/**
 * Group a labeled dataset by side.
 */
export function groupBySide<T extends { side: Side }>(data: T[]): Record<Side, T[]> {
  return {
    left: data.filter(d => d.side === 'left'),
    right: data.filter(d => d.side === 'right'),
  }
}

/**
 * Get the side color for consistent chart rendering.
 * Left = sky/blue (matches iOS), Right = purple/violet.
 */
export function getSideColor(side: Side, variant: 'primary' | 'muted' = 'primary'): string {
  const colors = {
    left: { primary: '#38bdf8', muted: '#38bdf833' },   // sky-400 / sky-400/20
    right: { primary: '#a78bfa', muted: '#a78bfa33' },  // violet-400 / violet-400/20
  }
  return colors[side][variant]
}

/**
 * Get the Tailwind CSS class for a side color.
 */
export function getSideColorClass(side: Side, type: 'text' | 'bg' | 'border' = 'text'): string {
  const classes = {
    left: { text: 'text-sky-400', bg: 'bg-sky-400', border: 'border-sky-400' },
    right: { text: 'text-violet-400', bg: 'bg-violet-400', border: 'border-violet-400' },
  }
  return classes[side][type]
}

/**
 * Get a human-friendly label for a side.
 */
export function getSideLabel(side: Side): string {
  return side === 'left' ? 'Left' : 'Right'
}
