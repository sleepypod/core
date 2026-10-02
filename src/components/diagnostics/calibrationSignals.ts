/**
 * Pure helpers for the Calibration page: read the baselines the calibrator
 * stores in `calibration_profiles.parameters` (modules/common/calibration.py)
 * and score live sensor frames against them.
 */

type Params = Record<string, unknown> | null | undefined

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const obj = (v: unknown): Record<string, unknown> | null =>
  (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)

// ── Piezo ────────────────────────────────────────────────────────────────────

export interface PiezoBaseline {
  /** Mean empty-bed peak-to-peak range per ~1s frame. */
  noiseRange: number
  /** Peak-to-peak range above which the bed reads as occupied. */
  threshold: number
}

export function parsePiezoParams(p: Params): PiezoBaseline | null {
  const noiseRange = num(p?.baseline_mean_range)
  const threshold = num(p?.presence_threshold)
  return noiseRange != null && threshold != null ? { noiseRange, threshold } : null
}

export interface EnvelopePoint { t: number, lo: number, hi: number }

/**
 * Min/max envelope of piezo frames, `buckets` points per frame. Each frame is
 * centred on its own mean so slow DC drift between frames doesn't hide the
 * waveform; the envelope's height is then the frame's peak-to-peak range.
 */
export function piezoEnvelope(frames: ReadonlyArray<{ t: number, samples: ReadonlyArray<number> }>, buckets = 8, frameMs = 1000): EnvelopePoint[] {
  const out: EnvelopePoint[] = []
  for (const f of frames) {
    const n = f.samples.length
    if (n === 0) continue
    let sum = 0
    for (const s of f.samples) sum += s
    const mean = sum / n
    const per = Math.max(1, Math.ceil(n / buckets))
    for (let i = 0; i < n; i += per) {
      let lo = Infinity
      let hi = -Infinity
      for (let j = i; j < Math.min(n, i + per); j++) {
        const v = f.samples[j] - mean
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      // Frames are stamped on arrival, so spread the buckets over the second before.
      out.push({ t: f.t - frameMs + ((i + per / 2) / n) * frameMs, lo, hi })
    }
  }
  return out
}

export function peakToPeak(samples: ReadonlyArray<number>): number | null {
  if (samples.length === 0) return null
  let lo = Infinity
  let hi = -Infinity
  for (const s of samples) {
    if (s < lo) lo = s
    if (s > hi) hi = s
  }
  return hi - lo
}

// ── Capacitance (capSense2) ──────────────────────────────────────────────────

const CAP_CHANNELS = ['A', 'B', 'C'] as const
export type CapChannel = (typeof CAP_CHANNELS)[number]
/** Must match CAPSENSE2_REF_NOMINAL in modules/common/calibration.py. */
const REF_NOMINAL = 1.16
const SENTINEL = -1

export interface CapBaseline {
  means: Record<CapChannel, number>
  stds: Record<CapChannel, number>
  threshold: number
  refMean: number
}

/** capSense2 baseline, or null for legacy capSense (Pod 3) and malformed params. */
export function parseCapParams(p: Params): CapBaseline | null {
  if (p?.format !== 'capSense2') return null
  const channels = obj(p.channels)
  const threshold = num(p.threshold)
  if (!channels || threshold == null) return null
  const means = {} as Record<CapChannel, number>
  const stds = {} as Record<CapChannel, number>
  for (const ch of CAP_CHANNELS) {
    const c = obj(channels[ch])
    const mean = num(c?.mean)
    const std = num(c?.std)
    if (mean == null || std == null) return null
    means[ch] = mean
    stds[ch] = std
  }
  return { means, stds, threshold, refMean: num(obj(p.ref)?.mean) ?? REF_NOMINAL }
}

export interface CapDeviation extends Record<CapChannel, number> {
  /** Summed deviation — what the sleep detector compares against the threshold. */
  sum: number
}

/**
 * Per-channel deviation from the empty-bed baseline with reference-channel
 * compensation, as src/lib/occupancy.ts and the sleep detector compute it.
 */
export function capDeviation(values: ReadonlyArray<number>, cal: CapBaseline): CapDeviation | null {
  if (values.length < 6 || values.slice(0, 6).some(v => v === SENTINEL)) return null
  const pair = (i: number) => (values[i] + values[i + 1]) / 2
  const refDelta = values.length >= 8 && values[6] !== SENTINEL && values[7] !== SENTINEL ? pair(6) - cal.refMean : 0
  const A = pair(0) - refDelta - cal.means.A
  const B = pair(2) - refDelta - cal.means.B
  const C = pair(4) - refDelta - cal.means.C
  return { A, B, C, sum: A + B + C }
}

/** Channels whose deviation sits within 3σ of the empty-bed baseline. */
export function channelsInBaseline(dev: CapDeviation, cal: CapBaseline): number {
  return CAP_CHANNELS.filter(ch => Math.abs(dev[ch]) <= 3 * cal.stds[ch]).length
}

/** ±3σ band for the summed deviation (channels treated as independent). */
export function capSumBand(cal: CapBaseline): number {
  return 3 * Math.sqrt(CAP_CHANNELS.reduce((s, ch) => s + cal.stds[ch] ** 2, 0))
}

// ── Temperature ──────────────────────────────────────────────────────────────

export const TEMP_ZONES = ['outer', 'center', 'inner'] as const
export type TempZone = (typeof TEMP_ZONES)[number]

/**
 * Calibrated mean per zone in °C (ambient mean + the zone's offset). The
 * calibrator works on bed_temp's centidegrees; values under 100 are taken as
 * already being °C.
 */
export function tempZoneMeansC(p: Params, side: 'left' | 'right'): Partial<Record<TempZone, number>> | null {
  const ambient = num(p?.ambient_mean)
  const offsets = obj(p?.offsets)
  if (ambient == null || !offsets) return null
  const scale = Math.abs(ambient) >= 100 ? 100 : 1
  const out: Partial<Record<TempZone, number>> = {}
  for (const z of TEMP_ZONES) {
    const off = num(offsets[`${side}_${z}_temp`])
    if (off != null) out[z] = (ambient + off) / scale
  }
  return Object.keys(out).length ? out : null
}

// ── Validity window ──────────────────────────────────────────────────────────

export interface Validity {
  /** Share of the validity window still remaining, 0–1. */
  remaining: number
  msLeft: number
}

export function validity(createdAt: Date | string | null | undefined, expiresAt: Date | string | null | undefined, now: number): Validity | null {
  if (!createdAt || !expiresAt) return null
  const start = new Date(createdAt).getTime()
  const end = new Date(expiresAt).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  const msLeft = end - now
  return { remaining: Math.max(0, Math.min(1, msLeft / (end - start))), msLeft }
}

export function fmtTimeLeft(ms: number): string {
  if (ms <= 0) return 'expired'
  const h = Math.floor(ms / 3_600_000)
  if (h >= 1) return `${h}h left`
  return `${Math.max(1, Math.floor(ms / 60_000))}m left`
}

/** Compact magnitude for raw ADC ranges: 48200000 → "48.2M". */
export function fmtCompact(n: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}
