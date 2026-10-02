'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSideNames } from '@/src/hooks/useSideNames'
import { Button, Card, CardHeader, InlineError, Skeleton, StatusDot } from '@/src/components/ds'
import { stepPath } from '@/src/components/Schedule/CurveChart'
import { NEUTRAL_TEMP_F, TONE_TEXT, TONE_VAR, tempTone } from '@/src/components/Schedule/scheduleFormat'
import { cn } from '@/lib/utils'
import {
  buildNights, describeSchedule, fmtIn, fmtTime, fmtWhen, groupCounts, heldTarget, jobGroup, jobText, nightAxis, podLane, sideLane,
  type JobGroup, type JobText, type Night, type Side, type TimelineJob, type TimelineOccurrence,
} from './schedulerLogic'

const HOUR = 3_600_000

/**
 * System → Scheduler: what the pod will do tonight, drawn per side as the
 * same eased curve the Schedule page uses, with the next few jobs below.
 * "All jobs" swaps in every loaded job grouped by kind.
 */
export function SchedulerPanel() {
  const timeline = trpc.health.schedulerTimeline.useQuery({ days: 8 }, { refetchInterval: 60_000 })
  const system = trpc.health.system.useQuery({}, { refetchInterval: 15_000 })
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const showAll = searchParams.get('view') === 'all'
  const now = useNow()

  const setShowAll = (all: boolean) => {
    const params = new URLSearchParams(searchParams.toString())
    if (all) params.set('view', 'all')
    else params.delete('view')
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }

  if (timeline.error) return <Card tone="danger"><InlineError>{timeline.error.message}</InlineError></Card>
  const data = timeline.data
  if (!data) {
    return (
      <>
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-[380px]" />
        <Skeleton className="h-[260px]" />
      </>
    )
  }

  const upcoming = data.occurrences.filter(o => o.at >= now)
  return (
    <>
      <SummaryLine
        enabled={data.enabled}
        jobs={data.jobs}
        drift={system.data?.scheduler.drift}
        next={upcoming[0]}
        now={now}
      />
      {showAll
        ? <AllJobs jobs={data.jobs} now={now} onBack={() => setShowAll(false)} />
        : (
            <>
              <NightTimeline occurrences={data.occurrences} now={now} next={upcoming[0]} />
              <NextUp upcoming={upcoming} now={now} onAll={() => setShowAll(true)} />
            </>
          )}
    </>
  )
}

/** Wall clock, ticking every 30 s so "in 5h 41m" and the now line stay current. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  return now
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof ResizeObserver === 'undefined') {
      setWidth(el.clientWidth || 640)
      return
    }
    const ro = new ResizeObserver(entries => setWidth(Math.floor(entries[0].contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

function JobValue({ text, className }: { text: JobText, className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: text.tone === 'muted' ? 'var(--text-3)' : TONE_VAR[text.tone] }} />
      <span className="truncate">{text.subject}</span>
      {text.value && (
        <>
          <span className="text-fg-3">→</span>
          <span className={cn('font-mono', text.tone === 'muted' ? 'text-fg-2' : TONE_TEXT[text.tone])}>{text.value}</span>
        </>
      )}
    </span>
  )
}

// ── Summary ──────────────────────────────────────────────────────────────────

function SummaryLine({ enabled, jobs, drift, next, now }: {
  enabled: boolean
  jobs: TimelineJob[]
  drift: { dbScheduleCount: number, schedulerJobCount: number, drifted: boolean } | undefined
  next: TimelineOccurrence | undefined
  now: number
}) {
  const { sideName } = useSideNames()
  const groups = groupCounts(jobs)
  const status = !enabled
    ? { tone: 'warn' as const, label: 'Disabled' }
    : drift?.drifted
      ? { tone: 'warn' as const, label: `Drifted · ${drift.dbScheduleCount} scheduled vs ${drift.schedulerJobCount} loaded` }
      : { tone: 'ok' as const, label: drift ? 'In sync' : 'Enabled' }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5" data-testid="scheduler-summary">
      <span className="flex items-center gap-2 text-sm">
        <StatusDot tone={status.tone} />
        {status.label}
      </span>
      <span className="font-mono text-xs text-fg-2">
        {[`${jobs.length} jobs`, ...groups.map(g => `${g.count} ${g.label}`)].join(' · ')}
      </span>
      {next && (
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-fg-2 @min-[760px]:ml-auto">
          next
          <JobValue text={jobText(next, sideName)} className="font-sans text-fg" />
          {`at ${fmtWhen(next.at, now)} · ${fmtIn(next.at, now)}`}
        </span>
      )}
    </div>
  )
}

// ── Timeline ─────────────────────────────────────────────────────────────────

const LABEL_COL = 92
const SIDE_H = 104
const POD_H = 48
const TOP = 22

function NightTimeline({ occurrences, now, next }: { occurrences: TimelineOccurrence[], now: number, next: TimelineOccurrence | undefined }) {
  const nights = useMemo(() => buildNights(occurrences, now), [occurrences, now])
  const [picked, setPicked] = useState(0)
  const night = nights[picked] ?? nights[0]
  const { sideName } = useSideNames()

  return (
    <Card data-testid="scheduler-timeline">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
        <span className="text-[15px] font-medium">{night.label}</span>
        <span className="font-mono text-xs text-fg-2">{`${night.dates} · ${night.occurrences.length} jobs`}</span>
        <div role="tablist" aria-label="Night" className="no-scrollbar flex max-w-full gap-0.5 overflow-x-auto rounded-ctl border border-line p-0.5 @min-[760px]:ml-auto">
          {nights.map((n, i) => (
            <button
              key={n.start}
              type="button"
              role="tab"
              aria-selected={i === picked}
              title={n.occurrences.length === 0 ? 'No jobs this night' : `${n.occurrences.length} jobs`}
              onClick={() => setPicked(i)}
              className={cn(
                'shrink-0 cursor-pointer rounded-[6px] px-2.5 py-1 text-[13px] transition-colors',
                i === picked ? 'bg-active text-fg' : n.occurrences.length === 0 ? 'text-fg-3 hover:bg-active' : 'text-fg-2 hover:bg-active',
              )}
            >
              {n.label}
            </button>
          ))}
        </div>
      </div>
      {night.occurrences.length === 0
        ? <p className="py-10 text-center text-sm text-fg-3">No jobs run this night.</p>
        : <NightChart night={night} now={now} next={next} sideName={sideName} />}
    </Card>
  )
}

function NightChart({ night, now, next, sideName }: { night: Night, now: number, next: TimelineOccurrence | undefined, sideName: (s: Side) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const svgRef = useRef<SVGSVGElement>(null)
  // Same hover as the Schedule chart: a line across the lanes and each side's target at that time.
  const [hover, setHover] = useState<number | null>(null)
  const { from, to } = nightAxis(night)
  const lanes = (['left', 'right'] as const).map(side => ({ side, lane: sideLane(night.occurrences, side) }))
  const pod = podLane(night.occurrences)
  const height = TOP + SIDE_H * 2 + POD_H + 22
  const X = (t: number) => ((t - from) / (to - from)) * width
  const ticks: number[] = []
  const stepH = width > 0 && width < 520 ? 4 : 2
  for (let t = from; t <= to; t += stepH * HOUR) ticks.push(t)
  const nowX = now >= from && now <= to ? X(now) : null

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = Math.max(0, Math.min(width, e.clientX - rect.left))
    setHover(from + (x / width) * (to - from))
  }
  const readout = hover === null
    ? null
    : {
        x: X(hover),
        label: [fmtTime(hover), ...lanes.map(({ side, lane }) => {
          const target = heldTarget(lane, hover)
          return `${sideName(side)} ${target === null ? '—' : `${target}°`}`
        })].join(' · '),
      }

  return (
    <div className="flex min-w-0">
      <div className="flex shrink-0 flex-col" style={{ width: LABEL_COL, paddingTop: TOP }}>
        {lanes.map(({ side, lane }) => {
          const temps = lane.points.map(p => p.tempF)
          return (
            <div key={side} className="flex flex-col justify-center gap-0.5" style={{ height: SIDE_H }}>
              <span className="truncate text-sm">{sideName(side)}</span>
              <span className="font-mono text-[11px] text-fg-3">
                {temps.length === 0 ? (lane.on.length || lane.off.length ? 'power only' : 'no schedule') : Math.min(...temps) === Math.max(...temps) ? `${temps[0]}°F` : `${Math.min(...temps)}–${Math.max(...temps)}°F`}
              </span>
            </div>
          )
        })}
        <div className="flex items-center text-sm" style={{ height: POD_H }}>Pod</div>
      </div>
      <div ref={ref} className="min-w-0 flex-1" style={{ height }}>
        {width > 0 && (
          <svg
            ref={svgRef}
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            className="block overflow-visible"
            role="img"
            aria-label={`Scheduled jobs, ${night.dates}`}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHover(null)}
          >
            {ticks.map(t => (
              <g key={t}>
                <line x1={X(t)} x2={X(t)} y1={TOP} y2={height - 22} stroke="var(--border-grid)" />
                <text x={X(t)} y={height - 6} textAnchor={t === from ? 'start' : t + stepH * HOUR > to ? 'end' : 'middle'} fill="var(--text-3)" fontSize="10" className="font-mono">
                  {new Date(t).toLocaleTimeString([], { hour: 'numeric' })}
                </text>
              </g>
            ))}
            {lanes.map(({ side, lane }, i) => (
              <SideCurve
                key={side}
                lane={lane}
                top={TOP + i * SIDE_H}
                width={width}
                X={X}
                next={next?.side === side && next.at >= from && next.at <= to ? next : undefined}
              />
            ))}
            <PodMarkers jobs={pod.filter(j => j.at >= from && j.at <= to)} y={TOP + SIDE_H * 2 + POD_H / 2} X={X} />
            <OffAxisNote jobs={pod.filter(j => j.at < from)} x={0} anchor="start" y={TOP + SIDE_H * 2 + POD_H / 2 + 18} />
            <OffAxisNote jobs={pod.filter(j => j.at > to)} x={width} anchor="end" y={TOP + SIDE_H * 2 + POD_H / 2 + 18} />
            {nowX != null && (
              <g data-testid="timeline-now">
                <line x1={nowX} x2={nowX} y1={12} y2={height - 22} stroke="var(--text-1)" strokeOpacity="0.6" />
                <text x={nowX + (nowX > width - 90 ? -4 : 4)} y={9} textAnchor={nowX > width - 90 ? 'end' : 'start'} fill="var(--text-1)" fontSize="10" className="font-mono">
                  {`now ${fmtTime(now)}`}
                </text>
              </g>
            )}
            {readout && (
              <g data-testid="timeline-hover" pointerEvents="none">
                <line x1={readout.x} x2={readout.x} y1={12} y2={height - 22} stroke="var(--text-1)" strokeOpacity="0.35" />
                <text
                  x={readout.x > width / 2 ? readout.x - 6 : readout.x + 6}
                  y={TOP + SIDE_H - 10}
                  textAnchor={readout.x > width / 2 ? 'end' : 'start'}
                  fill="var(--text-1)"
                  fontSize="10"
                  className="font-mono"
                >
                  {readout.label}
                </text>
              </g>
            )}
          </svg>
        )}
      </div>
    </div>
  )
}

function SideCurve({ lane, top, width, X, next }: {
  lane: ReturnType<typeof sideLane>
  top: number
  width: number
  X: (t: number) => number
  next: TimelineOccurrence | undefined
}) {
  const gradientId = `sched-${top}`
  const temps = lane.points.map(p => p.tempF)
  const lo = Math.min(NEUTRAL_TEMP_F, ...temps) - 1
  const hi = Math.max(NEUTRAL_TEMP_F, ...temps) + 1
  const pad = 16
  const Y = (v: number) => top + SIDE_H - pad - ((v - lo) / (hi - lo)) * (SIDE_H - pad * 2)
  const bottom = top + SIDE_H - 8
  const neutralY = Y(NEUTRAL_TEMP_F)

  const pts = lane.points.map(p => ({ x: X(p.at), y: Y(p.tempF), ...p }))
  // Hold the last set point until the side powers off.
  const lastOff = lane.off.filter(t => pts.length && t > lane.points[lane.points.length - 1].at)[0]
  const path = pts.length
    ? stepPath([...pts, ...(lastOff != null ? [{ x: X(lastOff), y: pts[pts.length - 1].y }] : [])])
    : ''
  const endX = lastOff != null ? X(lastOff) : pts[pts.length - 1]?.x ?? 0
  const maxP = pts.length ? pts.reduce((a, b) => (b.tempF > a.tempF ? b : a)) : null
  const minP = pts.length ? pts.reduce((a, b) => (b.tempF < a.tempF ? b : a)) : null
  const nextP = next ? pts.find(p => p.id === next.id && p.at === next.at) : undefined

  return (
    <g>
      <line x1={0} x2={width} y1={neutralY} y2={neutralY} stroke="var(--text-3)" strokeOpacity="0.5" strokeDasharray="1 4" />
      {pts.length > 0 && (
        <>
          <defs>
            <linearGradient id={gradientId} x1={pts[0].x} y1="0" x2={Math.max(endX, pts[0].x + 1)} y2="0" gradientUnits="userSpaceOnUse">
              {/* Hard stops: each hold keeps its tone right up to the step. */}
              {pts.flatMap((p, i) => {
                const offset = ((p.x - pts[0].x) / (Math.max(endX, pts[0].x + 1) - pts[0].x)).toFixed(3)
                const stops = [<stop key={`${i}-to`} offset={offset} stopColor={TONE_VAR[tempTone(p.tempF)]} />]
                if (i > 0) stops.unshift(<stop key={`${i}-from`} offset={offset} stopColor={TONE_VAR[tempTone(pts[i - 1].tempF)]} />)
                return stops
              })}
            </linearGradient>
          </defs>
          <path d={`${path} L${endX},${bottom} L${pts[0].x},${bottom} Z`} fill="var(--text-1)" fillOpacity="0.04" />
          <path d={path} fill="none" stroke={`url(#${gradientId})`} strokeWidth="2" strokeLinejoin="round" />
          {maxP && maxP.tempF !== minP?.tempF && (
            <text x={maxP.x} y={maxP.y - 8} textAnchor="middle" fill={TONE_VAR[tempTone(maxP.tempF)]} fontSize="10" className="font-mono">{`${maxP.tempF}°`}</text>
          )}
          {minP && (
            <text x={minP.x + 8} y={minP.y + (minP.y > neutralY ? 4 : -6)} fill={TONE_VAR[tempTone(minP.tempF)]} fontSize="10" className="font-mono">{`${minP.tempF}°`}</text>
          )}
        </>
      )}
      {lane.on.map(t => (
        <text key={`on-${t}`} x={X(t) - 4} y={bottom - 4} textAnchor="end" fill="var(--status-ok)" fontSize="10" className="font-mono">on</text>
      ))}
      {lane.off.map(t => (
        <g key={`off-${t}`}>
          <line x1={X(t)} x2={X(t)} y1={top + 10} y2={bottom} stroke="var(--text-3)" />
          <text x={X(t) + 4} y={bottom - 4} fill="var(--text-3)" fontSize="10" className="font-mono">off</text>
        </g>
      ))}
      {lane.alarms.map(t => (
        <g key={`alarm-${t}`}>
          <rect x={X(t) - 4} y={top + 6} width={8} height={8} transform={`rotate(45 ${X(t)} ${top + 10})`} fill="var(--status-warn)" />
          <text x={X(t) + 8} y={top + 14} fill="var(--status-warn)" fontSize="10" className="font-mono">alarm</text>
        </g>
      ))}
      {nextP && (
        <g data-testid="timeline-next">
          <circle cx={nextP.x} cy={nextP.y} r={6.5} fill="none" stroke="var(--text-1)" strokeWidth="1.5" />
          <text x={nextP.x} y={nextP.y - 12} textAnchor="middle" fill="var(--text-1)" fontSize="10" className="font-mono">{`next · ${nextP.tempF}°`}</text>
        </g>
      )}
    </g>
  )
}

function podJobLabel(j: TimelineOccurrence): string {
  if (j.type === 'led_brightness') return j.brightness == null ? 'LED' : `LED ${j.brightness}%`
  return jobText(j, () => '').subject
}

/** Label each marker unless it would overlap the previous label; the rest keep a tooltip. */
function placePodLabels(jobs: TimelineOccurrence[], X: (t: number) => number) {
  const placed: Array<{ job: TimelineOccurrence, x: number, label: string, showLabel: boolean }> = []
  let lastLabelEnd = -Infinity
  for (const job of jobs) {
    const x = X(job.at)
    const label = podJobLabel(job)
    const showLabel = x > lastLabelEnd + 6
    if (showLabel) lastLabelEnd = x + 12 + label.length * 6.2
    placed.push({ job, x, label, showLabel })
  }
  return placed
}

function PodMarkers({ jobs, y, X }: { jobs: TimelineOccurrence[], y: number, X: (t: number) => number }) {
  return (
    <g>
      {placePodLabels(jobs, X).map(({ job, x, label, showLabel }) => (
        <g key={`${job.id}-${job.at}`}>
          <title>{`${label} · ${fmtTime(job.at)}`}</title>
          <rect x={x - 4} y={y - 4} width={8} height={8} transform={`rotate(45 ${x} ${y})`} fill="var(--text-2)" />
          {showLabel && <text x={x + 9} y={y + 4} fill="var(--text-2)" fontSize="11" className="font-mono">{label}</text>}
        </g>
      ))}
    </g>
  )
}

/** Pod jobs outside the night's hours, in words: "also Reboot 1:00 PM · Prime 2:00 PM". */
function OffAxisNote({ jobs, x, y, anchor }: { jobs: TimelineOccurrence[], x: number, y: number, anchor: 'start' | 'end' }) {
  if (jobs.length === 0) return null
  return (
    <text x={x} y={y} textAnchor={anchor} fill="var(--text-3)" fontSize="10" className="font-mono">
      {`${anchor === 'start' ? 'earlier' : 'later'}: ${jobs.map(j => `${podJobLabel(j)} ${fmtTime(j.at)}`).join(' · ')}`}
    </text>
  )
}

// ── Next up ──────────────────────────────────────────────────────────────────

function NextUp({ upcoming, now, onAll }: { upcoming: TimelineOccurrence[], now: number, onAll: () => void }) {
  const { sideName } = useSideNames()
  const rows = upcoming.slice(0, 5)
  return (
    <Card>
      <CardHeader
        title={(
          <span className="flex items-baseline gap-2.5">
            Next up
            <span className="font-mono text-xs font-normal text-fg-2">{`${rows.length} of ${upcoming.length} this week`}</span>
          </span>
        )}
        right={<button type="button" onClick={onAll} className="cursor-pointer text-[13px] text-cool hover:underline">All jobs</button>}
      />
      {rows.length === 0
        ? <p className="text-sm text-fg-3">Nothing scheduled.</p>
        : (
            <div className="flex flex-col">
              {rows.map(o => (
                <div key={`${o.id}-${o.at}`} className="grid grid-cols-[88px_1fr_auto] items-center gap-3 border-t border-line py-2.5 text-sm first:border-t-0 @min-[640px]:grid-cols-[96px_110px_1fr_auto]">
                  <span className="font-mono">{fmtWhen(o.at, now)}</span>
                  <span className="hidden font-mono text-fg-2 @min-[640px]:block">{fmtIn(o.at, now)}</span>
                  <JobValue text={jobText(o, sideName)} />
                  <span className="truncate font-mono text-xs text-fg-3">{o.id}</span>
                </div>
              ))}
            </div>
          )}
    </Card>
  )
}

// ── All jobs ─────────────────────────────────────────────────────────────────

const GROUP_TITLE: Record<JobGroup, string> = {
  temperature: 'Temperature',
  power: 'Power',
  alarm: 'Alarms',
  maintenance: 'Maintenance',
  other: 'Other',
}
const PREVIEW_ROWS = 12

function AllJobs({ jobs, now, onBack }: { jobs: TimelineJob[], now: number, onBack: () => void }) {
  const { sideName } = useSideNames()
  const [filter, setFilter] = useState<JobGroup | null>(null)
  const [expanded, setExpanded] = useState<Set<JobGroup>>(new Set())
  const groups = groupCounts(jobs)
  const sorted = [...jobs].sort((a, b) => (a.nextRun ?? Infinity) - (b.nextRun ?? Infinity))

  return (
    <Card data-testid="scheduler-all-jobs">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={onBack}>Tonight</Button>
        <span className="text-[15px] font-medium">All jobs</span>
        <div className="flex flex-wrap gap-1.5 @min-[760px]:ml-auto" role="group" aria-label="Filter by kind">
          <FilterChip on={filter == null} onClick={() => setFilter(null)} label="All" count={jobs.length} />
          {groups.map(g => (
            <FilterChip key={g.id} on={filter === g.id} onClick={() => setFilter(g.id)} label={GROUP_TITLE[g.id]} count={g.count} />
          ))}
        </div>
      </div>
      {groups.filter(g => filter == null || g.id === filter).map((g) => {
        const rows = sorted.filter(j => jobGroup(j.type) === g.id)
        const open = expanded.has(g.id) || filter === g.id
        const shown = open ? rows : rows.slice(0, PREVIEW_ROWS)
        return (
          <section key={g.id} className="flex flex-col">
            <div className="flex items-baseline gap-2 border-b border-line pb-1.5 pt-2">
              <span className="text-sm font-medium">{GROUP_TITLE[g.id]}</span>
              <span className="font-mono text-xs text-fg-3">{rows.length}</span>
            </div>
            {shown.map(j => (
              <div key={j.id} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 border-b border-line py-2 text-sm last:border-b-0 @min-[760px]:grid-cols-[minmax(160px,1.2fr)_minmax(160px,1.4fr)_150px_minmax(90px,auto)]">
                <JobValue text={jobText(j, sideName)} />
                <span className="text-right text-xs text-fg-2 @min-[760px]:text-left @min-[760px]:text-sm">{describeSchedule(j)}</span>
                <span className="font-mono text-xs text-fg-2">{j.nextRun == null ? 'not scheduled' : `${fmtWhen(j.nextRun, now)} · ${fmtIn(j.nextRun, now)}`}</span>
                <span className="truncate text-right font-mono text-[11px] text-fg-3">{j.id}</span>
              </div>
            ))}
            {rows.length > shown.length && (
              <button
                type="button"
                className="cursor-pointer self-start py-2 text-[13px] text-cool hover:underline"
                onClick={() => setExpanded(prev => new Set(prev).add(g.id))}
              >
                {`Show all ${rows.length}`}
              </button>
            )}
          </section>
        )
      })}
    </Card>
  )
}

function FilterChip({ on, onClick, label, count }: { on: boolean, onClick: () => void, label: string, count: number }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'cursor-pointer rounded-full border px-2.5 py-1 text-xs transition-colors',
        on ? 'border-line-2 bg-active text-fg' : 'border-line text-fg-2 hover:bg-active',
      )}
    >
      {label}
      <span className="ml-1.5 font-mono text-fg-3">{count}</span>
    </button>
  )
}
