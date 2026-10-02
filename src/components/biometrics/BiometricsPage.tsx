/**
 * Sleep → Biometrics. One person and one range (Night | Week | Month) drive
 * every card: a stale-pipeline banner when the side is in bed but vitals
 * stopped, the range summary, the three-row vitals chart, both sides' live
 * presence, and the sessions table (click a session to zoom the chart to that
 * night). The per-minute table lives in the Raw log drawer.
 */
'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ArrowRight, ChevronRight, HeartPulse, List } from 'lucide-react'
import { cn } from '@/lib/utils'
import { trpc } from '@/src/utils/trpc'
import { Button, Modal, PageHeader, SegmentedControl, Skeleton } from '@/src/components/ds'
import { langFromPath } from '@/src/components/AppShell/navItems'
import { useNowMinute } from '@/src/components/Schedule/CurveChart'
import { DiagTable, type DiagColumn } from '@/src/components/diagnostics/DiagTable'
import { fmtNum } from '@/src/components/diagnostics/diagnosticsLogic'
import { useBiometricsSide } from '@/src/hooks/useBiometricsSide'
import { useSideNames } from '@/src/hooks/useSideNames'
import { OccupancyCheck } from '@/src/components/diagnostics/OccupancyCheck'
import { RawDataButton } from './RawDataButton'
import { VitalsChart, VitalsLegend } from './VitalsChart'
import {
  baselineBand, clock, fmtDuration, formatRangeLabel, METRICS, metricStats, nightWindow, rangeWindow, SESSION_GAP_MS, splitSessions, STALE_MS,
  type BiometricsRange, type MetricDef, type MetricKey, type RangeWindow, type Session, type VitalPoint,
} from './biometricsLogic'

type Side = 'left' | 'right'

interface VitalRow { side: string, timestamp: Date, heartRate: number | null, hrv: number | null, breathingRate: number | null }

const RANGES: Array<{ value: BiometricsRange, label: string }> = [
  { value: 'night', label: 'Night' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
]

const VITALS_DEFAULT_SORT = { key: 'timestamp', dir: 'desc' } as const

export function BiometricsPage({ sectionSwitch }: { sectionSwitch?: ReactNode }) {
  const nowMinute = useNowMinute()
  if (nowMinute == null) return <Skeleton className="h-[480px]" />
  return <BiometricsBody sectionSwitch={sectionSwitch} now={nowMinute * 60_000} />
}

function BiometricsBody({ sectionSwitch, now }: { sectionSwitch?: ReactNode, now: number }) {
  const lang = langFromPath(usePathname())
  const { side, toggleSide } = useBiometricsSide()
  const { leftName, rightName, sideName } = useSideNames()
  const [range, setRange] = useState<BiometricsRange>('week')
  // A session picked from the table pins the chart to that night.
  const [focus, setFocus] = useState<RangeWindow | null>(null)
  const [rawLogOpen, setRawLogOpen] = useState(false)
  const win = focus ?? rangeWindow(range, now)
  const startDate = new Date(win.start)
  const endDate = new Date(win.end)

  const vitalsQ = trpc.biometrics.getVitals.useQuery({ side, startDate, endDate, limit: 20000 }, { refetchInterval: 60_000, placeholderData: prev => prev })
  const summaryQ = trpc.biometrics.getVitalsSummary.useQuery({ side, startDate, endDate }, { refetchInterval: 60_000 })
  const latestQ = trpc.biometrics.getVitals.useQuery({ side, limit: 1 }, { refetchInterval: 30_000 })
  const occupancyQ = trpc.biometrics.getOccupancy.useQuery(undefined, { refetchInterval: 10_000 })
  // Health's read of whether "occupied" is believable (no movement, no vitals for hours → suspect).
  const dataPathQ = trpc.health.dataPath.useQuery({}, { refetchInterval: 60_000 })
  const fileCountQ = trpc.biometrics.getFileCount.useQuery({}, { refetchInterval: 60_000 })
  const movementQ = trpc.biometrics.getMovementBuckets.useQuery({ side, startDate, endDate, bucketSeconds: 300, limit: 10000 }, { refetchInterval: 5 * 60_000 })

  const rows = (vitalsQ.data ?? []) as VitalRow[]
  const points: VitalPoint[] = rows.map(r => ({ t: new Date(r.timestamp).getTime(), hr: r.heartRate, hrv: r.hrv, br: r.breathingRate }))
  const sessions = splitSessions(points)
  const bands = { hr: baselineBand(points, 'hr'), hrv: baselineBand(points, 'hrv'), br: baselineBand(points, 'br') }

  const lastVitalAt = latestQ.data?.[0] ? new Date(latestQ.data[0].timestamp).getTime() : null
  const occupied = occupancyQ.data?.[side].occupied ?? false
  const suspect = dataPathQ.data?.occupancy[side] === 'suspect'
  const stale = occupied && !suspect && (lastVitalAt == null || now - lastVitalAt > STALE_MS)
  const includesNow = win.start <= now && now <= win.end
  const stall = stale && includesNow && lastVitalAt != null && lastVitalAt >= win.start ? { start: lastVitalAt, end: now } : null
  const rangeLabel = formatRangeLabel(win)
  const bandLabel = `middle 50% of the ${focus || range === 'night' ? 'night' : range}`

  const pickRange = (next: BiometricsRange) => {
    setFocus(null)
    setRange(next)
  }
  const zoomTo = (s: Session) => {
    setRange('night')
    setFocus(nightWindow(s.start))
  }

  return (
    <>
      <span className="-mb-2 hidden font-mono text-[13px] text-fg-2 min-[900px]:block">Sleep /</span>
      <PageHeader
        title={(
          <>
            <span className="min-[900px]:hidden">Sleep</span>
            <span className="hidden min-[900px]:inline">Biometrics</span>
          </>
        )}
        right={(
          <>
            {toggleSide && (
              <SegmentedControl
                ariaLabel="Person"
                options={[{ value: 'left', label: leftName }, { value: 'right', label: rightName }]}
                value={side}
                onChange={(next: Side) => {
                  if (next !== side) toggleSide()
                  setFocus(null)
                }}
              />
            )}
            <SegmentedControl ariaLabel="Range" className="max-[899px]:hidden" options={RANGES} value={range} onChange={pickRange} />
          </>
        )}
      />
      <div className="flex flex-col gap-3.5 min-[900px]:hidden">
        {sectionSwitch}
        <SegmentedControl ariaLabel="Range" full options={RANGES} value={range} onChange={pickRange} />
      </div>

      {occupied && suspect && (
        <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-warn-line bg-warn-bg/50 px-4 py-3 text-[14px] text-warn" role="status" data-testid="suspect-banner">
          <HeartPulse size={18} className="shrink-0" />
          <span className="min-w-0 flex-1 basis-[240px]">
            {lastVitalAt == null
              ? `${sideName(side)}’s side reads occupied, but no vitals have arrived and nobody has moved in over 2 hours.`
              : `${sideName(side)}’s side reads occupied, but the last vital arrived ${fmtDuration(now - lastVitalAt)} ago and nobody has moved since.`}
          </span>
          <OccupancyCheck sides={[side]} size="sm" />
        </div>
      )}

      {stale && (
        <div className="flex items-center gap-3 rounded-[10px] border border-warn-line bg-warn-bg/50 px-4 py-3 text-[14px] text-warn" role="status" data-testid="stale-banner">
          <HeartPulse size={18} className="shrink-0" />
          <span className="min-w-0 flex-1">
            {lastVitalAt == null
              ? `${sideName(side)}’s side is occupied, but no vitals have arrived. The pipeline may be stalled.`
              : `${sideName(side)}’s side is occupied, but the last vital arrived ${fmtDuration(now - lastVitalAt)} ago. The pipeline may be stalled.`}
          </span>
          <Link href={`/${lang}/system?tab=health&node=piezo-processor`} className="flex shrink-0 items-center gap-1 text-warn no-underline hover:underline">
            Health
            <ArrowRight size={15} />
          </Link>
        </div>
      )}

      <SummaryRow summary={summaryQ.data ?? null} loading={summaryQ.isLoading} />

      <div className="flex min-w-0 flex-col gap-4 rounded-card border border-line bg-surface px-[18px] py-4 min-[900px]:px-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[15px] font-medium">Vitals</span>
          <span className="font-mono text-xs text-fg-2">
            {`${rangeLabel} · ${sessions.length} session${sessions.length === 1 ? '' : 's'} with data`}
          </span>
          {focus && (
            <button type="button" onClick={() => setFocus(null)} className="cursor-pointer border-0 bg-transparent p-0 font-mono text-xs text-link hover:underline">
              clear
            </button>
          )}
          <span className="ml-auto font-mono text-xs text-fg-3">empty stretches removed</span>
        </div>
        {vitalsQ.isLoading
          ? <Skeleton className="h-[320px]" />
          : sessions.length === 0 && !stall
            ? <div className="grid h-[200px] place-items-center text-[13px] text-fg-3">No vitals in this range</div>
            : (
                <div className="-mx-[18px] overflow-x-auto px-[18px]">
                  <div className="min-w-[560px]">
                    <VitalsChart sessions={sessions} stall={stall} bands={bands} />
                  </div>
                </div>
              )}
        <VitalsLegend bandLabel={bandLabel} stalled={!!stall} />
      </div>

      <SidesCard occupancy={occupancyQ.data} sideName={sideName} />

      <SessionsCard
        sessions={sessions}
        rangeLabel={rangeLabel}
        now={now}
        ongoing={includesNow && occupied ? sessions[sessions.length - 1] ?? null : null}
        stale={stale}
        lastVitalAt={lastVitalAt}
        movement={movementQ.data ?? []}
        onSelect={zoomTo}
        footer={(
          <>
            <span className="font-mono text-xs text-fg-2">
              {[
                summaryQ.data ? `${summaryQ.data.recordCount} records` : null,
                fileCountQ.data ? `${fileCountQ.data.rawFiles.left}+${fileCountQ.data.rawFiles.right} raw files` : null,
                fileCountQ.data ? `${fileCountQ.data.totalSizeMB} MB` : null,
              ].filter(Boolean).join(' · ')}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button icon={List} size="sm" onClick={() => setRawLogOpen(true)}>Raw log</Button>
              <RawDataButton variant="button" range={{ start: startDate, end: endDate }} />
            </div>
          </>
        )}
      />

      <RawLog open={rawLogOpen} onClose={() => setRawLogOpen(false)} rows={rows} loading={vitalsQ.isLoading} title={`Raw log · ${sideName(side)} · ${rangeLabel}`} />
    </>
  )
}

function Swatch({ color }: { color: string }) {
  return <span className="h-0.5 w-2.5 shrink-0 rounded" style={{ background: color }} />
}

function SummaryRow({ summary, loading }: {
  summary: { avgHeartRate: number | null, minHeartRate: number | null, maxHeartRate: number | null, avgHRV: number | null, avgBreathingRate: number | null } | null
  loading: boolean
}) {
  const [hr, hrv, br] = METRICS
  const cells: Array<{ label: string, color: string, value: string, unit: string }> = [
    { label: 'Avg heart rate', color: hr.color, value: fmtNum(summary?.avgHeartRate), unit: 'bpm' },
    { label: 'HR range', color: hr.color, value: summary?.minHeartRate != null && summary.maxHeartRate != null ? `${fmtNum(summary.minHeartRate)}–${fmtNum(summary.maxHeartRate)}` : '—', unit: 'bpm' },
    { label: 'Avg HRV', color: hrv.color, value: fmtNum(summary?.avgHRV), unit: 'ms' },
    { label: 'Avg breathing', color: br.color, value: fmtNum(summary?.avgBreathingRate, 1), unit: 'br/min' },
  ]
  return (
    <div className="@container rounded-card border border-line bg-surface" data-testid="biometrics-summary">
      <div className="grid grid-cols-2 @min-[640px]:grid-cols-4">
        {cells.map((c, i) => (
          <div
            key={c.label}
            className={cn(
              'flex flex-col gap-2 border-line px-[18px] py-4 min-[900px]:px-6',
              i % 2 === 1 && 'border-l',
              i >= 2 && 'border-t @min-[640px]:border-t-0',
              i === 2 && '@min-[640px]:border-l',
            )}
          >
            <span className="flex items-center gap-2 text-[13px] text-fg-2">
              <Swatch color={c.color} />
              {c.label}
            </span>
            <span className="font-mono tabular-nums">
              <span className="text-[24px] font-light">{loading ? '…' : c.value}</span>
              <span className="ml-1.5 text-xs text-fg-2">{c.unit}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

interface OccupancyLike {
  occupied: boolean
  available: boolean
  movement: { active: boolean, peakScore: number }
  level: { deviation: number | null }
}

function SidesCard({ occupancy, sideName }: { occupancy: Record<Side, OccupancyLike> | undefined, sideName: (s: Side) => string }) {
  return (
    <div className="@container rounded-card border border-line bg-surface" data-testid="sides-card">
      <div className="grid @min-[640px]:grid-cols-2">
        {(['left', 'right'] as const).map((sd, i) => {
          const o = occupancy?.[sd]
          return (
            <div key={sd} className={cn('flex flex-col gap-3.5 px-[18px] py-4 min-[900px]:px-6', i === 1 && 'border-t border-line @min-[640px]:border-t-0 @min-[640px]:border-l')}>
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-medium">{sideName(sd)}</span>
                <span className="font-mono text-[11px] tracking-wide text-fg-3 uppercase">{sd}</span>
                {o && (
                  <span className={cn('ml-auto flex items-center gap-1.5 text-[13px]', o.occupied ? 'text-ok' : 'text-fg-2')}>
                    <span className="size-1.5 rounded-full bg-current" />
                    {o.occupied ? 'In bed' : 'Empty'}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Available" value={o ? (o.available ? 'yes' : 'no') : '—'} />
                <Field label="Movement" value={o ? (o.movement.active ? `active (${fmtNum(o.movement.peakScore)})` : 'idle') : '—'} />
                <Field label="Level dev" value={o ? fmtNum(o.level.deviation, 1) : '—'} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string, value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[13px] text-fg-2">{label}</span>
      <span className="truncate font-mono text-[15px] tabular-nums">{value}</span>
    </div>
  )
}

function RangeBar({ metric, stats }: { metric: MetricDef, stats: { avg: number, min: number, max: number } }) {
  const [lo, hi] = metric.domain
  const x = (v: number) => ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * 110
  return (
    <svg width={110} height={8} className="block" aria-hidden>
      <rect x={0} y={3} width={110} height={2} rx={1} fill="var(--border-1)" />
      <rect x={x(stats.min)} y={3} width={Math.max(1, x(stats.max) - x(stats.min))} height={2} rx={1} fill={metric.color} fillOpacity={0.45} />
      <circle cx={x(stats.avg)} cy={4} r={3.5} fill={metric.color} />
    </svg>
  )
}

function MetricCell({ metric, points }: { metric: MetricDef, points: VitalPoint[] }) {
  const stats = metricStats(points, metric.key)
  if (!stats) return <span className="font-mono text-fg-3">—</span>
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono tabular-nums whitespace-nowrap">
        <span className="text-[15px]">{stats.avg.toFixed(metric.digits)}</span>
        <span className="ml-2 text-[11px] text-fg-2">{`${stats.min.toFixed(metric.digits)}–${stats.max.toFixed(metric.digits)}`}</span>
      </span>
      <RangeBar metric={metric} stats={stats} />
    </div>
  )
}

const HEAD: Record<MetricKey, string> = { hr: 'Heart rate · bpm', hrv: 'HRV · ms', br: 'Breathing · /min' }

function SessionsCard({ sessions, rangeLabel, now, ongoing, stale, lastVitalAt, movement, onSelect, footer }: {
  sessions: Session[]
  rangeLabel: string
  now: number
  /** The session still in progress (side in bed now), if any. */
  ongoing: Session | null
  stale: boolean
  lastVitalAt: number | null
  movement: Array<{ bucketStart: Date, eventCount: number }>
  onSelect: (s: Session) => void
  footer: ReactNode
}) {
  const rows = [...sessions].reverse()
  const movements = (s: Session) => movement
    .filter(b => new Date(b.bucketStart).getTime() >= s.start - 5 * 60_000 && new Date(b.bucketStart).getTime() <= s.end)
    .reduce((n, b) => n + b.eventCount, 0)

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-card border border-line bg-surface px-[18px] py-4 min-[900px]:px-6" data-testid="sessions-card">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="text-[15px] font-medium">Sessions</span>
        <span className="font-mono text-xs text-fg-2">{`${rangeLabel} · ${sessions.length}`}</span>
      </div>
      <div className="-mx-[18px] overflow-x-auto px-[18px] min-[900px]:-mx-6 min-[900px]:px-6">
        <div className="min-w-[720px]">
          <div className="grid grid-cols-[minmax(200px,1.5fr)_1fr_1fr_1fr_70px_20px] gap-x-4 border-b border-line pb-2.5 font-mono text-[11px] tracking-wide text-fg-2 uppercase">
            <span>Session</span>
            {METRICS.map(m => <span key={m.key}>{HEAD[m.key]}</span>)}
            <span className="text-right">Readings</span>
            <span />
          </div>
          {rows.length === 0 && <div className="py-6 text-[13px] text-fg-3">No sessions in this range</div>}
          {rows.map((s) => {
            const isOngoing = s === ongoing && (stale || now - s.end < SESSION_GAP_MS)
            const date = new Date(s.start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '')
            const endLabel = isOngoing ? 'now' : clock(s.end)
            const stalled = isOngoing && stale
            return (
              <button
                key={s.start}
                type="button"
                onClick={() => onSelect(s)}
                className="group grid w-full cursor-pointer grid-cols-[minmax(200px,1.5fr)_1fr_1fr_1fr_70px_20px] items-center gap-x-4 border-0 border-b border-grid bg-transparent py-4 text-left text-fg last:border-b-0 hover:bg-active"
                data-testid="session-row"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-[15px]">
                    {date}
                    <span className="ml-1.5 font-mono text-fg-2">{`${clock(s.start)} → ${endLabel}`}</span>
                  </span>
                  {stalled
                    ? (
                        <span className="flex items-start gap-1.5 font-mono text-[11px] text-warn">
                          <span className="mt-[5px] size-1.5 shrink-0 rounded-full bg-current" />
                          {`in bed ${fmtDuration(now - s.start)} · no vitals since ${lastVitalAt != null ? clock(lastVitalAt) : '—'}`}
                        </span>
                      )
                    : (
                        <span className="font-mono text-[11px] text-fg-2">
                          {`${fmtDuration(s.end - s.start)} · ${movements(s)} movement${movements(s) === 1 ? '' : 's'}`}
                        </span>
                      )}
                </div>
                {METRICS.map(m => <MetricCell key={m.key} metric={m} points={s.points} />)}
                <span className="text-right font-mono text-[15px] tabular-nums">{s.points.length}</span>
                <ChevronRight size={16} className="text-fg-3 group-hover:text-fg-2" />
              </button>
            )
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3.5">{footer}</div>
    </div>
  )
}

function RawLog({ open, onClose, rows, loading, title }: { open: boolean, onClose: () => void, rows: VitalRow[], loading: boolean, title: string }) {
  const columns: Array<DiagColumn<VitalRow>> = [
    { key: 'timestamp', header: 'Time', render: r => <span className="font-mono text-xs text-fg-2">{new Date(r.timestamp).toLocaleString()}</span>, sortValue: r => new Date(r.timestamp).getTime() },
    { key: 'heartRate', header: 'HR', align: 'right', render: r => fmtNum(r.heartRate), sortValue: r => r.heartRate ?? -1 },
    { key: 'hrv', header: 'HRV', align: 'right', render: r => fmtNum(r.hrv), sortValue: r => r.hrv ?? -1 },
    { key: 'breathingRate', header: 'BR', align: 'right', render: r => fmtNum(r.breathingRate, 1), sortValue: r => r.breathingRate ?? -1 },
  ]
  return (
    <Modal open={open} onClose={onClose} title={title} icon={List} iconClassName="text-icon" width={560}>
      <DiagTable
        columns={columns}
        rows={rows}
        getRowKey={(r, i) => `${new Date(r.timestamp).getTime()}-${i}`}
        empty={loading ? 'Loading…' : 'No vitals in this range'}
        searchText={r => `${new Date(r.timestamp).toLocaleString()} ${fmtNum(r.heartRate)} ${fmtNum(r.hrv)} ${fmtNum(r.breathingRate, 1)}`}
        pageSize={25}
        defaultSort={VITALS_DEFAULT_SORT}
      />
    </Modal>
  )
}
