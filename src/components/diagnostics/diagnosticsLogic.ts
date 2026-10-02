/**
 * Pure view-model logic for the diagnostics console — formatting, the
 * scheduler job shape, and the biometrics/thermal derivations. Kept free of React
 * and tRPC so it can be unit-tested directly; the console is a thin view over
 * these functions.
 */

import { formatDisplayTemp } from '@/src/lib/tempUtils'

// ── Formatting ───────────────────────────────────────────────────────────────

// Thermal diagnostics are engineering telemetry and intentionally displayed in
// Fahrenheit to match hardware setpoints and scheduler payloads.
export function fmtF(v: number | null | undefined): string {
  return formatDisplayTemp(v, 'F', { decimals: 1, nullDisplay: '—' })
}

export function fmtAge(sec: number | null | undefined): string {
  if (sec == null) return 'no reading'
  if (sec < 90) return `${sec}s`
  return `${Math.round(sec / 60)}m`
}

export function fmtMs(ms: number | undefined): string {
  if (ms == null) return '—'
  if (ms < 1) return '<1ms'
  return `${Math.round(ms)}ms`
}

export function fmtNum(v: number | null | undefined, digits = 0): string {
  return v == null ? '—' : v.toFixed(digits)
}

export function minutesSince(ms: number): number {
  return Math.max(0, Math.floor((Date.now() - ms) / 60000))
}

export function fmtClock(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—'
}

export const VERDICT_STYLES: Record<string, { label: string, className: string }> = {
  delivering: { label: 'DELIVERING', className: 'text-ok' },
  holding: { label: 'HOLDING', className: 'text-hold' },
  off: { label: 'OFF', className: 'text-fg-3' },
  stalled: { label: 'STALLED', className: 'text-danger' },
  unknown: { label: 'NO PUMP DATA', className: 'text-fg-2' },
}

/**
 * Header status for a thermal side card: while delivering, show the direction
 * the pod is driving the bed (COOLING / WARMING, in the matching accent);
 * otherwise the raw verdict.
 */
export function thermalDirection(side: {
  verdict: string
  isPowered: boolean
  targetTempF: number | null
  currentTempF: number | null
}): { label: string, className: string } {
  const v = VERDICT_STYLES[side.verdict] ?? { label: side.verdict.toUpperCase(), className: 'text-fg-2' }
  if (side.verdict !== 'delivering' || !side.isPowered || side.targetTempF == null || side.currentTempF == null) return v
  if (side.targetTempF < side.currentTempF - 0.5) return { label: 'COOLING', className: 'text-cool' }
  if (side.targetTempF > side.currentTempF + 0.5) return { label: 'WARMING', className: 'text-warm' }
  return { label: 'HOLDING', className: 'text-hold' }
}

// ── Scheduler jobs ─────────────────────────────────────────────────────────────

export interface SchedJob {
  id: string
  type: string
  side?: string
  nextRun: string | null
  targetTempF?: number | null
  brightness?: number | null
}

// ── Biometrics data-flow check ──────────────────────────────────────────────────

export type FlowTone = 'ok' | 'warn' | 'error' | 'idle'

interface VitalLike { timestamp: Date | string }
interface OccupancyLike { left: { occupied: boolean }, right: { occupied: boolean } }
interface FileCountLike { rawFiles: { left: number, right: number } }

/**
 * Synthesize a live "is biometric data being written" verdict. The failure we
 * care about: an occupied bed while the ingest pipeline has quietly stalled, so
 * vitals stop arriving even though everything reports healthy.
 */
export function biometricsFlowStatus(
  rows: VitalLike[],
  occupancy: OccupancyLike | undefined,
  fileCount: FileCountLike | undefined,
): { tone: FlowTone, label: string } {
  const lastMs = rows.length ? Math.max(...rows.map(r => new Date(r.timestamp).getTime())) : null
  const ageMin = lastMs != null ? minutesSince(lastMs) : null
  const rawTotal = fileCount ? fileCount.rawFiles.left + fileCount.rawFiles.right : null
  const occupied = occupancy ? occupancy.left.occupied || occupancy.right.occupied : false
  const fresh = ageMin != null && ageMin <= 10

  if (lastMs == null && !rawTotal) {
    return { tone: 'error', label: 'No biometric data — nothing is being written' }
  }
  if (occupied && !fresh) {
    return {
      tone: 'warn',
      label: ageMin == null
        ? 'Bed occupied but no vitals recorded — pipeline may be stalled'
        : `Bed occupied but last vital was ${ageMin}m ago — pipeline may be stalled`,
    }
  }
  if (fresh) {
    return { tone: 'ok', label: `Data flowing · last record ${ageMin}m ago${rawTotal != null ? ` · ${rawTotal} RAW files` : ''}` }
  }
  return {
    tone: 'idle',
    label: ageMin == null ? 'No recent vitals (bed empty)' : `No recent vitals · last ${ageMin}m ago (bed empty)`,
  }
}

// ── Thermal trend ───────────────────────────────────────────────────────────────

export interface ThermalSideSnapshot {
  side: string
  isPowered: boolean
  targetTempF: number | null
  currentTempF: number | null
  waterTempF: number | null
}

