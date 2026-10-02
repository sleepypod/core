/**
 * View-model for Sleep → Biometrics: range windows, splitting per-minute
 * vitals into in-bed sessions, the 9-minute smoothing and p25–p75 baseline
 * band, and the compressed x axis (only sessions are drawn; the empty
 * stretches between them collapse to fixed-width breaks). Pure — times are
 * epoch ms — so it's tested without React.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export type BiometricsRange = 'night' | 'week' | 'month'
export type MetricKey = 'hr' | 'hrv' | 'br'

export interface MetricDef {
  key: MetricKey
  label: string
  unit: string
  /** Fixed chart domain — shared by the chart row and the session range bars. */
  domain: [number, number]
  ticks: number[]
  color: string
  digits: number
}

export const METRICS: readonly MetricDef[] = [
  { key: 'hr', label: 'Heart rate', unit: 'bpm', domain: [36, 90], ticks: [40, 60, 80], color: 'var(--chart-vital-hr)', digits: 0 },
  { key: 'hrv', label: 'HRV', unit: 'ms', domain: [0, 110], ticks: [0, 50, 100], color: 'var(--chart-vital-hrv)', digits: 0 },
  { key: 'br', label: 'Breathing', unit: 'br/min', domain: [10, 26], ticks: [12, 18, 24], color: 'var(--chart-vital-br)', digits: 1 },
]

export interface VitalPoint { t: number, hr: number | null, hrv: number | null, br: number | null }

export interface Session {
  start: number
  end: number
  points: VitalPoint[]
}

/** A new session starts when readings are more than this far apart. */
export const SESSION_GAP_MS = 30 * MINUTE
/** A vital older than this while the side is occupied means the pipeline stalled. */
export const STALE_MS = 15 * MINUTE

// ── Ranges ──────────────────────────────────────────────────────────────────

export interface RangeWindow { start: number, end: number }

function startOfDay(ms: number): Date {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** The noon-to-noon night a moment belongs to (bed at 1 AM is the night before). */
export function nightWindow(ms: number): RangeWindow {
  const d = new Date(ms - 12 * HOUR)
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime()
  return { start, end: start + DAY }
}

/**
 * Night = the current noon-to-noon night; Week/Month = the last 7/30 calendar
 * days through the end of today (a stable end, so queries don't re-key every
 * minute).
 */
export function rangeWindow(range: BiometricsRange, now: number): RangeWindow {
  if (range === 'night') return nightWindow(now)
  const days = range === 'week' ? 7 : 30
  const today = startOfDay(now)
  return {
    start: new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1)).getTime(),
    end: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime(),
  }
}

/** `Sep 22–28`, `Sep 28–Oct 4`, or a single `Sep 28`. */
export function formatRangeLabel(w: RangeWindow): string {
  const a = new Date(w.start)
  const b = new Date(Math.max(w.start, w.end - 1))
  const month = (d: Date) => d.toLocaleDateString('en-US', { month: 'short' })
  if (a.toDateString() === b.toDateString()) return `${month(a)} ${a.getDate()}`
  if (a.getMonth() === b.getMonth()) return `${month(a)} ${a.getDate()}–${b.getDate()}`
  return `${month(a)} ${a.getDate()}–${month(b)} ${b.getDate()}`
}

// ── Sessions ────────────────────────────────────────────────────────────────

/** Split time-sorted readings into sessions wherever the gap exceeds `gapMs`. */
export function splitSessions(points: VitalPoint[], gapMs = SESSION_GAP_MS): Session[] {
  const sorted = [...points].sort((a, b) => a.t - b.t)
  const out: Session[] = []
  for (const p of sorted) {
    const cur = out[out.length - 1]
    if (cur && p.t - cur.end <= gapMs) {
      cur.points.push(p)
      cur.end = p.t
    }
    else {
      out.push({ start: p.t, end: p.t, points: [p] })
    }
  }
  return out
}

/**
 * Centred rolling mean over ±(window/2) minutes by timestamp, ignoring nulls.
 * A point whose own value is null stays null so gaps aren't painted over.
 */
export function rollingMean(points: VitalPoint[], key: MetricKey, windowMin = 9): Array<number | null> {
  const half = (windowMin / 2) * MINUTE
  const out: Array<number | null> = []
  let lo = 0
  let hi = 0
  let sum = 0
  let n = 0
  for (let i = 0; i < points.length; i++) {
    const t = points[i].t
    while (hi < points.length && points[hi].t <= t + half) {
      const v = points[hi][key]
      if (v != null) {
        sum += v
        n++
      }
      hi++
    }
    while (points[lo].t < t - half) {
      const v = points[lo][key]
      if (v != null) {
        sum -= v
        n--
      }
      lo++
    }
    out.push(points[i][key] == null || n === 0 ? null : sum / n)
  }
  return out
}

/** Linear-interpolated percentile of an ascending array (p in 0–1). */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

/** The middle 50% (p25–p75) of a metric across the readings. */
export function baselineBand(points: VitalPoint[], key: MetricKey): { lo: number, hi: number } | null {
  const vals = points.map(p => p[key]).filter((v): v is number => v != null).sort((a, b) => a - b)
  const lo = percentile(vals, 0.25)
  const hi = percentile(vals, 0.75)
  return lo == null || hi == null ? null : { lo, hi }
}

export interface MetricStats { avg: number, min: number, max: number }

export function metricStats(points: VitalPoint[], key: MetricKey): MetricStats | null {
  let sum = 0
  let n = 0
  let min = Infinity
  let max = -Infinity
  for (const p of points) {
    const v = p[key]
    if (v == null) continue
    sum += v
    n++
    min = Math.min(min, v)
    max = Math.max(max, v)
  }
  return n ? { avg: sum / n, min, max } : null
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** `3h 56m`, `42m`, `6h 09m`. */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / MINUTE))
  const h = Math.floor(total / 60)
  const m = total % 60
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

/** Break label between sessions: `28 h`, `3 d`, `45 min`. */
export function fmtGap(ms: number): string {
  if (ms >= 2 * DAY) return `${Math.round(ms / DAY)} d`
  if (ms >= HOUR) return `${Math.round(ms / HOUR)} h`
  return `${Math.round(ms / MINUTE)} min`
}

export const clock = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

/** `SUN SEP 27 · 4h 17m` */
export function sessionHeader(s: { start: number, end: number }): string {
  const d = new Date(s.start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '').toUpperCase()
  return `${d} · ${fmtDuration(s.end - s.start)}`
}

// ── X axis ──────────────────────────────────────────────────────────────────

export const BREAK_PX = 24
export const STALL_PX = 90
const MIN_SEGMENT_PX = 8

export interface Segment {
  kind: 'session' | 'stall'
  x: number
  w: number
  start: number
  end: number
  index: number
}

export interface AxisLayout {
  segments: Segment[]
  breaks: Array<{ x: number, gapMs: number }>
  /** Time → x for a time inside a segment (clamped to it). */
  xOf: (seg: Segment, t: number) => number
}

/**
 * Lay sessions side by side across `width`, each as wide as its share of the
 * total session time, with a fixed break between them and an optional fixed
 * stalled segment (from the last reading to now) at the end.
 */
export function layoutAxis(sessions: Array<{ start: number, end: number }>, width: number, stall: { start: number, end: number } | null): AxisLayout {
  const breaks = Math.max(0, sessions.length - 1)
  const stallW = stall ? STALL_PX : 0
  const available = Math.max(0, width - breaks * BREAK_PX - stallW)
  const durations = sessions.map(s => Math.max(MINUTE, s.end - s.start))
  const total = durations.reduce((a, b) => a + b, 0) || 1
  const raw = durations.map(d => Math.max(MIN_SEGMENT_PX, (d / total) * available))
  const scale = raw.reduce((a, b) => a + b, 0) > available && available > 0 ? available / raw.reduce((a, b) => a + b, 0) : 1
  const segments: Segment[] = []
  const gaps: AxisLayout['breaks'] = []
  let x = 0
  sessions.forEach((s, i) => {
    if (i > 0) {
      gaps.push({ x: x + BREAK_PX / 2, gapMs: s.start - sessions[i - 1].end })
      x += BREAK_PX
    }
    const w = raw[i] * scale
    segments.push({ kind: 'session', x, w, start: s.start, end: s.end, index: i })
    x += w
  })
  if (stall) segments.push({ kind: 'stall', x, w: STALL_PX, start: stall.start, end: stall.end, index: sessions.length })
  const xOf = (seg: Segment, t: number) => {
    const span = Math.max(1, seg.end - seg.start)
    return seg.x + (Math.min(Math.max(t, seg.start), seg.end) - seg.start) / span * seg.w
  }
  return { segments, breaks: gaps, xOf }
}

const TICK_STEPS_H = [1, 2, 3, 6, 12, 24]

/**
 * Ticks for one session segment: on the hour (thinned so labels stay ≥ `minPx`
 * apart), plus the session start when it isn't crowding the first hour.
 */
export function segmentTicks(seg: { start: number, end: number, w: number }, minPx = 46): Array<{ t: number, label: string }> {
  const span = Math.max(MINUTE, seg.end - seg.start)
  const pxPerHour = seg.w / (span / HOUR)
  const step = TICK_STEPS_H.find(h => h * pxPerHour >= minPx) ?? 24
  const first = new Date(seg.start)
  first.setMinutes(0, 0, 0)
  let t = first.getTime() + HOUR
  while (new Date(t).getHours() % step !== 0) t += HOUR
  const out: Array<{ t: number, label: string }> = []
  const startLabel = clock(seg.start).replace(/ [AP]M$/, '')
  const firstGapPx = ((t - seg.start) / HOUR) * pxPerHour
  if (firstGapPx >= minPx * 0.8 || t > seg.end) out.push({ t: seg.start, label: startLabel })
  for (; t <= seg.end; t += step * HOUR) {
    const d = new Date(t)
    const label = step >= 24
      ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : clock(t).replace(':00', '')
    out.push({ t, label })
  }
  return out
}

/** Nearest reading to `t` in a session (readings are time-sorted). */
export function nearestIndex(points: VitalPoint[], t: number): number {
  let lo = 0
  let hi = points.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (points[mid].t < t) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(points[lo - 1].t - t) <= Math.abs(points[lo].t - t)) return lo - 1
  return lo
}

/** Clamp to a metric's chart domain rather than letting values overflow the row. */
export function clampTo(v: number, [lo, hi]: [number, number]): number {
  return Math.min(hi, Math.max(lo, v))
}
