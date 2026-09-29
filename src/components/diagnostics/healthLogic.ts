import { NODES, STAGES, type CheckStatus, type NodeId, type Stage } from '@/src/lib/dataPath'
import type { Tone } from '@/src/components/ds'

// Geometry for the data-path map, in SVG user units.
export const MAP = {
  colGap: 196,
  nodeW: 168,
  /** Left inset of a node's label and metric, past the status dot. */
  textX: 24,
  nodeH: 50,
  rowH: 64,
  top: 26,
  padX: 4,
} as const

export interface PlacedNode { id: NodeId, stage: Stage, x: number, y: number }

/** Columns by stage, each column centred on the tallest one. */
export function layoutMap(nodes: ReadonlyArray<{ id: NodeId, stage: Stage }>) {
  const cols = STAGES.map(s => nodes.filter(n => n.stage === s.id))
  const rows = Math.max(...cols.map(c => c.length))
  const placed: PlacedNode[] = cols.flatMap((col, ci) => col.map((n, ri) => ({
    id: n.id,
    stage: n.stage,
    x: MAP.padX + ci * MAP.colGap,
    y: MAP.top + ((rows - col.length) * MAP.rowH) / 2 + ri * MAP.rowH,
  })))
  return {
    placed,
    width: MAP.padX * 2 + (STAGES.length - 1) * MAP.colGap + MAP.nodeW,
    laneY: MAP.top + rows * MAP.rowH - (MAP.rowH - MAP.nodeH) + LANE_GAP / 2,
    height: MAP.top + rows * MAP.rowH - (MAP.rowH - MAP.nodeH) + LANE_GAP,
    stageX: STAGES.map((s, i) => ({ ...s, x: MAP.padX + i * MAP.colGap })),
  }
}

/** IBM Plex Mono advance at 11px, for fitting a metric inside its node. */
const MONO_11_ADVANCE = 6.6

/** The metric as it fits under a node's label: cut with an ellipsis rather than run past the edge. */
export function fitMetric(text: string): string {
  const max = Math.floor((MAP.nodeW - MAP.textX - 4) / MONO_11_ADVANCE)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** URL form of a node, e.g. `node=live-stream`: its label, kebab-cased. */
export function nodeSlug(id: NodeId): string {
  const label = NODES.find(n => n.id === id)?.label ?? id
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

/** A `node=` value back to its node; accepts the slug or the raw id. */
export function nodeFromSlug(slug: string | null): NodeId | null {
  if (!slug) return null
  return NODES.find(n => nodeSlug(n.id) === slug || n.id === slug)?.id ?? null
}

/** Links that skip a column run along this lane under the nodes instead of through them. */
export const LANE_GAP = 22

/** Link from the right edge of one node to the left edge of another. */
export function edgePath(a: PlacedNode, b: PlacedNode, laneY: number): string {
  const x1 = a.x + MAP.nodeW
  const y1 = a.y + MAP.nodeH / 2
  const x2 = b.x
  const y2 = b.y + MAP.nodeH / 2
  if (x2 - x1 > MAP.colGap) {
    const r = 18
    const out = x1 + (MAP.colGap - MAP.nodeW) / 2
    const back = x2 - (MAP.colGap - MAP.nodeW) / 2
    return `M${x1},${y1} L${out - r},${y1} Q${out},${y1} ${out},${y1 + r} L${out},${laneY - r} Q${out},${laneY} ${out + r},${laneY} `
      + `L${back - r},${laneY} Q${back},${laneY} ${back},${laneY - r} L${back},${y2 + r} Q${back},${y2} ${back + r},${y2} L${x2},${y2}`
  }
  const bend = Math.min(80, (x2 - x1) / 2)
  return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`
}

export const STATUS_TONE: Record<CheckStatus, Tone> = {
  ok: 'ok',
  idle: 'muted',
  stale: 'warn',
  down: 'danger',
  unknown: 'muted',
}

export const STATUS_WORD: Record<CheckStatus, string> = {
  ok: 'flowing',
  idle: 'idle',
  stale: 'stalled',
  down: 'down',
  unknown: 'unknown',
}

/** Strip fill per status; idle is healthy-but-quiet, so it recedes. */
export const STATUS_FILL: Record<CheckStatus, string> = {
  ok: 'bg-ok',
  idle: 'bg-line-2',
  stale: 'bg-warn',
  down: 'bg-danger',
  unknown: 'bg-fg-3/40',
}

export function fmtSpan(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}

export function fmtClockMs(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** A problem shorter than this is a blip; more than two in a day is recurring. */
const BLIP_MS = 5 * 60_000
const RECURRING = 3

export interface IncidentLine {
  key: string
  tone: Tone
  title: string
  when: string
  /** "blip" · "recurring" · "ongoing" — how to read it. */
  tag: 'blip' | 'recurring' | 'ongoing' | null
  detail: string | null
}

function joinAnd(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

export function incidentLines(
  history: {
    incidents: Array<{ checkId: NodeId, label: string, status: 'stale' | 'down', start: number, end: number | null, detail: string | null }>
    gaps: Array<{ start: number, end: number }>
    checks: Array<{ id: NodeId, incidents: number }>
  },
  now: number,
): IncidentLine[] {
  const counts = new Map(history.checks.map(c => [c.id, c.incidents]))
  // Checks that broke and recovered together read as one incident: "Sleep
  // detector and Sleep sessions stalled", with the first check's description.
  const together = new Map<string, Array<(typeof history.incidents)[number]>>()
  for (const i of history.incidents) {
    const k = `${i.start}-${i.end}`
    together.set(k, [...(together.get(k) ?? []), i])
  }
  const lines: Array<{ line: IncidentLine, sortAt: number }> = [...together.values()].map((group) => {
    const i = group[0]
    const end = i.end ?? now
    const tag = i.end == null ? 'ongoing' : group.some(g => (counts.get(g.checkId) ?? 0) >= RECURRING) ? 'recurring' : end - i.start < BLIP_MS ? 'blip' : null
    const down = group.some(g => g.status === 'down')
    return {
      line: {
        key: `${i.checkId}-${i.start}`,
        tone: down ? 'danger' : 'warn',
        title: `${joinAnd(group.map(g => g.label))} ${down ? 'down' : 'stalled'}`,
        when: `${fmtClockMs(i.start)} – ${i.end == null ? 'now' : fmtClockMs(i.end)} · ${fmtSpan(end - i.start)}`,
        tag,
        detail: i.detail,
      },
      sortAt: end,
    }
  })
  for (const g of history.gaps) {
    lines.push({
      line: {
        key: `gap-${g.start}`,
        tone: 'muted',
        title: 'Not recorded',
        when: `${fmtClockMs(g.start)} – ${g.end >= now - 60_000 ? 'now' : fmtClockMs(g.end)} · ${fmtSpan(g.end - g.start)}`,
        tag: null,
        detail: 'The core service wasn’t running, so nothing was checked.',
      },
      sortAt: g.end,
    })
  }
  return lines.sort((a, b) => b.sortAt - a.sortAt).map(l => l.line)
}

// ── History, condensed ──────────────────────────────────────────────────────

interface Run { status: CheckStatus, start: number, end: number }
interface HistoryCheck { id: NodeId, label: string, runs: Run[], healthyShare: number | null, incidents: number }

export interface HistoryRow {
  key: string
  label: string
  runs: Run[]
  healthyShare: number | null
  incidents: number
  /** The collapsed "{n} other checks" row. */
  rest?: { checks: number }
}

const runsKey = (runs: Run[]) => runs.map(r => `${r.status}:${r.start}:${r.end}`).join('|')

/** Checks whose 24 hours are identical, as one row: "Piezo processor · Vitals". */
export function groupIdentical(checks: HistoryCheck[]): HistoryRow[] {
  const groups = new Map<string, HistoryCheck[]>()
  for (const c of checks) {
    const k = runsKey(c.runs)
    groups.set(k, [...(groups.get(k) ?? []), c])
  }
  return [...groups.values()].map(g => ({
    key: g.map(c => c.id).join('+'),
    label: g.map(c => c.label).join(' · '),
    runs: g[0].runs,
    healthyShare: g[0].healthyShare,
    incidents: Math.max(...g.map(c => c.incidents)),
  }))
}

/** When checks disagree, the worst one colours the strip; flowing outranks idle. */
const RANK: Record<CheckStatus, number> = { down: 4, stale: 3, ok: 2, idle: 1, unknown: 0 }

/** One strip for many checks: per stretch of time, the worst status among them. */
export function mergeRuns(all: Run[][]): Run[] {
  const edges = [...new Set(all.flatMap(runs => runs.flatMap(r => [r.start, r.end])))].sort((a, b) => a - b)
  const at = all.map(() => 0)
  const out: Run[] = []
  for (let i = 0; i < edges.length - 1; i++) {
    const start = edges[i]
    const end = edges[i + 1]
    let worst: CheckStatus | null = null
    all.forEach((runs, ci) => {
      while (at[ci] < runs.length && runs[at[ci]].end <= start) at[ci]++
      const r = runs[at[ci]]
      if (r && r.start <= start && (worst == null || RANK[r.status] > RANK[worst])) worst = r.status
    })
    if (worst == null) continue
    const last = out[out.length - 1]
    if (last && last.status === worst && last.end === start) last.end = end
    else out.push({ status: worst, start, end })
  }
  return out
}

/**
 * Checks with an incident keep their own row (identical ones grouped); the
 * rest fold into one dimmed row. `all` lists every check on its own.
 */
export function condenseChecks(checks: HistoryCheck[], all: boolean): HistoryRow[] {
  if (all) return checks.map(c => ({ key: c.id, label: c.label, runs: c.runs, healthyShare: c.healthyShare, incidents: c.incidents }))
  const hit = checks.filter(c => c.incidents > 0)
  const rest = checks.filter(c => c.incidents === 0)
  const rows = groupIdentical(hit)
  if (rest.length === 1) rows.push(...groupIdentical(rest))
  else if (rest.length > 1) {
    const shares = rest.map(c => c.healthyShare).filter((v): v is number => v != null)
    rows.push({
      key: 'rest',
      label: `${rest.length} other checks`,
      runs: mergeRuns(rest.map(c => c.runs)),
      healthyShare: shares.length ? Math.min(...shares) : null,
      incidents: 0,
      rest: { checks: rest.length },
    })
  }
  return rows
}
