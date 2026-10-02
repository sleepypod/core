/**
 * View-model for System → Databases: growth projection against free disk,
 * per-table write strips, and the integrity / migration wording. Pure so it
 * can be unit-tested without React/tRPC.
 */

const DAY = 86_400_000

export interface TableLike {
  name: string
  rows: number
  bytes: number
  rows24h: number
  timeColumn?: string | null
  lastWriteAt: number | null
  hourly: number[]
  retention: { days: number, by: string } | null
}

export type GrowthKind = 'retained' | 'growing' | 'static'

/** Time columns that move when a row is updated, so they count touches, not new rows. */
const UPDATE_COLUMNS = new Set(['updated_at', 'last_updated', 'last_checked'])

/** Bytes a table adds per day at the last 24 h's insert rate. */
export function dailyGrowth(t: Pick<TableLike, 'rows' | 'bytes' | 'rows24h' | 'timeColumn'>): number {
  if (t.timeColumn && UPDATE_COLUMNS.has(t.timeColumn)) return 0
  return t.rows > 0 ? (t.rows24h * t.bytes) / t.rows : 0
}

/** Unpruned and growing by at least 4 KB a day: worth a "not pruned" flag. */
export function isUnprunedGrowth(t: TableLike): boolean {
  return !t.retention && dailyGrowth(t) >= 4096
}

export function growthKind(t: TableLike): GrowthKind {
  if (t.retention) return 'retained'
  return dailyGrowth(t) > 0 ? 'growing' : 'static'
}

/**
 * Projected size `days` from now. A retained table converges on its steady
 * state (a retention window of today's writes), reaching it once the window
 * has filled; anything unpruned grows linearly for as long as it writes.
 */
export function sizeAfter(t: TableLike, days: number): number {
  const perDay = dailyGrowth(t)
  if (!t.retention) return t.bytes + perDay * days
  const steady = perDay * t.retention.days
  if (t.bytes <= steady) return Math.min(steady, t.bytes + perDay * days)
  return t.bytes + (steady - t.bytes) * Math.min(1, days / t.retention.days)
}

/** Days until a retained table stops growing, or null if it already has. */
export function daysToSteady(t: TableLike): number | null {
  const perDay = dailyGrowth(t)
  if (!t.retention || perDay <= 0) return null
  const gap = perDay * t.retention.days - t.bytes
  return gap > 0 ? gap / perDay : null
}

export interface Outlook {
  horizonDays: number
  /** Bytes the databases can reach before the disk is full. */
  limit: number | null
  /** Days until the projection crosses `limit`; null if not within 10 years. */
  fillDays: number | null
  /** Latest day a retained table levels off. */
  steadyDays: number | null
  samples: Array<{ day: number, retained: number, growing: number, static: number }>
  growingPerDay: number
  /** Unpruned tables that still grow, largest daily growth first. */
  growers: Array<{ name: string, perDay: number }>
  retainedCount: number
}

export function projectOutlook(tables: TableLike[], availableBytes: number | null, points = 120): Outlook {
  const total = (d: number) => tables.reduce((s, t) => s + sizeAfter(t, d), 0)
  const limit = availableBytes == null ? null : tables.reduce((s, t) => s + t.bytes, 0) + availableBytes

  let fillDays: number | null = null
  if (limit != null) {
    for (let d = 0; d <= 3650; d += 1) {
      if (total(d) >= limit) {
        fillDays = d
        break
      }
    }
  }
  const steady = tables.map(daysToSteady).filter((d): d is number => d != null)
  const steadyDays = steady.length ? Math.max(...steady) : null
  const horizonDays = fillDays != null
    ? Math.max(60, Math.ceil(fillDays * 1.15))
    : Math.max(180, Math.min(730, Math.ceil((steadyDays ?? 0) * 1.5)))

  const samples = Array.from({ length: points + 1 }, (_, i) => {
    const day = (horizonDays * i) / points
    const s = { day, retained: 0, growing: 0, static: 0 }
    for (const t of tables) s[growthKind(t)] += sizeAfter(t, day)
    return s
  })

  const growers = tables
    .filter(t => growthKind(t) === 'growing')
    .map(t => ({ name: t.name, perDay: dailyGrowth(t) }))
    .sort((a, b) => b.perDay - a.perDay)

  return {
    horizonDays,
    limit,
    fillDays,
    steadyDays,
    samples,
    growingPerDay: growers.reduce((s, g) => s + g.perDay, 0),
    growers,
    retainedCount: tables.filter(t => t.retention).length,
  }
}

function monthYear(ms: number): string {
  return new Date(ms).toLocaleDateString([], { month: 'long', year: 'numeric' })
}

function shortDay(ms: number): string {
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** The outlook in one or two plain sentences. */
export function outlookSentence(o: Outlook, now: number, fmt: (bytes: number) => string): string {
  const parts: string[] = []
  if (o.fillDays != null) parts.push(`At current growth the disk fills around ${monthYear(now + o.fillDays * DAY)}.`)
  else if (o.growingPerDay > 0) parts.push(`At current growth the databases add ${fmt(o.growingPerDay * 365)} a year; the disk has room for more than ten.`)
  else parts.push('Nothing grows without bound; the databases stay about this size.')
  if (o.retainedCount > 0) {
    parts.push(o.steadyDays != null
      ? `Retention holds ${o.retainedCount} tables flat after ${shortDay(now + o.steadyDays * DAY)}.`
      : `Retention already holds ${o.retainedCount} tables flat.`)
  }
  const top = o.growers.filter(g => g.perDay >= 1024)
  if (top.length === 1) parts.push(`${top[0].name} isn’t pruned and keeps growing.`)
  else if (top.length > 1) parts.push(`${top.slice(0, 2).map(g => g.name).join(' and ')} aren’t pruned and keep growing.`)
  return parts.join(' ')
}

// ── Write strips ─────────────────────────────────────────────────────────────

/** Tables that only write while someone is in bed, so a quiet occupied hour is a gap. */
export const OCCUPANCY_TABLES = new Set(['vitals', 'vitals_quality'])

export type StripCell = 'write' | 'idle' | 'missing'

export function stripCells(t: Pick<TableLike, 'name' | 'hourly'>, occupiedHours: ReadonlySet<number>): StripCell[] {
  return t.hourly.map((n, h) => (n > 0 ? 'write' : OCCUPANCY_TABLES.has(t.name) && occupiedHours.has(h) ? 'missing' : 'idle'))
}

/** True when the table's newest hours are occupied but empty: data stopped arriving. */
export function isStalled(cells: StripCell[]): boolean {
  for (let i = cells.length - 1; i >= 0; i--) {
    if (cells[i] === 'write') return false
    if (cells[i] === 'missing') return true
  }
  return false
}

// ── Wording ──────────────────────────────────────────────────────────────────

export function fmtAgo(ms: number, now: number): string {
  const min = Math.max(0, Math.round((now - ms) / 60_000))
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

/** "7:01 PM" today, "Sun 8:24 AM" this week, "Sep 24" before that. */
export function fmtLastWrite(ms: number, now: number): string {
  const d = new Date(ms)
  const n = new Date(now)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === n.toDateString()) return time
  if (now - ms < 6 * DAY) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
  return shortDay(ms)
}

export function fmtRetention(days: number): string {
  return days <= 2 ? `${Math.round(days * 24)} h` : `${Math.round(days)} d`
}

export function migrationNote(m: { applied: number, known: number, appliedTag: string | null, latestTag: string | null }): { text: string, warn: boolean } {
  if (m.known === 0) return { text: 'migration journal not found', warn: false }
  if (m.applied > m.known) return { text: `${m.applied - m.known} applied by another build`, warn: true }
  if (m.applied < m.known) return { text: `${m.known - m.applied} pending`, warn: true }
  return { text: m.appliedTag ?? m.latestTag ?? '', warn: false }
}

/** Local "2026-09-28 15:05:23" for a row's time column. */
export function fmtRowTime(v: number, inMs: boolean): string {
  const d = new Date(inMs ? v : v * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function toCsv(columns: string[], rows: Array<Array<string | number | null>>): string {
  const esc = (v: string | number | null) => {
    if (v == null) return ''
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [columns.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n')
}
