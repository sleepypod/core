'use client'

import { useState, type PointerEvent } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ArrowRight, Clock, GitBranch, WifiOff } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'
import { useSideNames } from '@/src/hooks/useSideNames'
import { useShownSides } from '@/src/providers/SideProvider'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { Button, Card, HoverMark, InlineError, KeyValue, Skeleton, StatusDot, useHoverFraction } from '@/src/components/ds'
import { cn } from '@/lib/utils'
import { formatSetpointF } from '@/src/lib/tempUtils'
import { langFromPath } from '@/src/components/AppShell/navItems'
import { HealthRing } from '@/src/components/status/HealthCircle'
import { PumpAlertsCard } from '@/src/components/status/PumpAlertsCard'
import { formatUptime, useStatusSummary } from '@/src/components/status/StatusScreen'
import { CurveChart, CurveLegend, buildTimeline, readAt, useNowMinute } from '@/src/components/Schedule/CurveChart'
import { bedTrace } from '@/src/components/Schedule/bedTrace'
import { formatCountdown, nightSetPoints } from '@/src/components/Schedule/bothNight'
import { fmtClock, fmtF, thermalDirection, type SchedJob } from './diagnosticsLogic'
import { attentionItems, isPodLaneJob, jobsInWindow, nextTemperatureJob, podJobLabel, tonightWindow, TONIGHT_END_H, TONIGHT_START_H } from './dashboardLogic'
import { nearestPoint, panelDomain, seriesPath, THERMAL_PANELS } from './thermalHistoryLogic'
import type { DiagSection } from './DiagnosticsConsole'
import { OccupancyCheck } from './OccupancyCheck'

type ThermalData = inferRouterOutputs<AppRouter>['health']['thermal']
type ThermalSide = ThermalData['sides'][number]
type Side = 'left' | 'right'

/**
 * System → Dashboard: one status line, an attention list that only appears
 * when something needs action, tonight's plan for both sides and the pod, and
 * a compact card per side with its last 12 hours.
 */
export function DashboardPanel({ thermal, onJump }: { thermal: ThermalData | undefined, onJump: (s: DiagSection) => void }) {
  // One side away: the sleeper's side only.
  const shown = useShownSides()
  return (
    <>
      <StatusLine />
      <AttentionCard />
      <PumpAlertsCard />
      <TonightCard onJump={onJump} />
      <div className={cn('grid items-start gap-3.5', shown.length > 1 && '@min-[760px]:grid-cols-2')}>
        {thermal
          ? thermal.sides.filter(s => shown.includes(s.side as Side)).map(s => <SideSummaryCard key={s.side} side={s} onClick={() => onJump('thermal')} />)
          : (
              <>
                {shown.map(side => <Skeleton key={side} className="h-[170px]" />)}
              </>
            )}
      </div>
    </>
  )
}

// ── Status line ─────────────────────────────────────────────────────────────

function StatusLine() {
  const s = useStatusSummary()
  const checks = Object.values(s.groups).flat()
  const failing = checks.filter(c => c.status !== 'ok')
  const commit = s.version && s.version.commitHash !== 'unknown' ? s.version.commitHash.slice(0, 7) : null
  const branch = s.version && s.version.branch !== 'unknown' ? s.version.branch : null
  const headline = s.total > 0 && s.healthy === s.total
    ? `${s.podName ?? 'Pod'} is healthy`
    : `${s.healthy} of ${s.total} checks passing`
  const title = checks.map(c => `${c.status === 'ok' ? '✓' : '✗'} ${c.name}: ${c.value}`).join('\n')

  const facts = [
    {
      label: 'Build',
      value: branch || commit
        ? (
            <>
              {branch && <GitBranch size={12} className="shrink-0 text-icon" />}
              {branch && <span className="truncate">{branch}</span>}
              {commit && <span className="shrink-0 rounded-tag border border-line-2 px-1 text-[11px] leading-4 text-fg-2">{commit}</span>}
            </>
          )
        : '—',
    },
    {
      label: 'Wi-Fi',
      value: !s.wifi
        ? '—'
        : s.wifi.connected
          ? (
              <>
                <SignalBars percent={s.wifi.signal ?? 0} />
                <span className="truncate">{s.wifi.ssid ?? 'connected'}</span>
                <span className="shrink-0 text-fg-2">{`${s.wifi.signal ?? 0}%`}</span>
              </>
            )
          : (
              <>
                <WifiOff size={12} className="shrink-0" />
                offline
              </>
            ),
      className: s.wifi && !s.wifi.connected ? 'text-warn' : undefined,
    },
    {
      label: 'Internet',
      value: s.internetBlocked === undefined
        ? '—'
        : <StatusDot tone={s.internetBlocked ? 'muted' : 'ok'} label={s.internetBlocked ? 'Blocked' : 'Allowed'} className="text-[13px] text-fg" />,
    },
    {
      label: 'Firewall',
      value: !s.firewall
        ? '—'
        : s.firewall.ok
          ? <StatusDot tone="ok" label="In place" className="text-[13px] text-fg" />
          : <StatusDot tone="warn" label={`Missing ${s.firewall.missing.length === 1 ? s.firewall.missing[0] : `${s.firewall.missing.length} rules`}`} className="text-[13px]" />,
      title: s.firewall && !s.firewall.ok ? `Missing firewall rules: ${s.firewall.missing.join(', ')}` : undefined,
    },
    {
      label: 'Disk',
      value: s.diskPercent !== undefined
        ? (
            <>
              <UsageBar percent={s.diskPercent} />
              {`${Math.round(s.diskPercent)}% used`}
            </>
          )
        : '—',
    },
    {
      label: 'Uptime',
      value: s.uptimeSeconds !== undefined
        ? (
            <>
              <Clock size={12} className="shrink-0 text-icon" />
              {formatUptime(s.uptimeSeconds)}
            </>
          )
        : '—',
    },
  ]

  return (
    <Card className="flex-row flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3" data-testid="status-line">
      <div className="flex min-w-0 items-center gap-3" title={title}>
        <HealthRing healthy={s.healthy} total={s.total} size={44} caption={false} />
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-medium">{headline}</span>
          {failing.length > 0 && (
            <span className="truncate font-mono text-[11px] text-warn">{failing.map(c => c.name).join(' · ')}</span>
          )}
        </div>
      </div>
      <div className="grid min-w-0 flex-1 grid-cols-2 gap-x-6 gap-y-2 @min-[560px]:flex @min-[560px]:flex-wrap @min-[900px]:justify-end">
        {facts.map(f => (
          <div key={f.label} className="min-w-0" title={'title' in f ? f.title : undefined}>
            <div className="text-xs text-fg-2">{f.label}</div>
            <div className={cn('flex min-w-0 items-center gap-1.5 font-mono text-[13px]', f.className)}>{f.value}</div>
          </div>
        ))}
      </div>
    </Card>
  )
}

/** Four rising bars, lit by Wi-Fi signal strength (0–100%). */
function SignalBars({ percent }: { percent: number }) {
  const lit = percent >= 75 ? 4 : percent >= 50 ? 3 : percent >= 25 ? 2 : percent > 0 ? 1 : 0
  return (
    <span className="flex h-3 shrink-0 items-end gap-px" role="img" aria-label={`Signal ${lit} of 4`}>
      {[1, 2, 3, 4].map(i => (
        <span key={i} className={cn('w-[3px] rounded-[1px]', i <= lit ? (lit <= 1 ? 'bg-warn' : 'bg-ok') : 'bg-active')} style={{ height: `${i * 25}%` }} />
      ))}
    </span>
  )
}

/** Thin usage meter; amber from 80%, red from 90%. */
function UsageBar({ percent }: { percent: number }) {
  const p = Math.min(100, Math.max(0, percent))
  return (
    <span className="h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-active" aria-hidden>
      <span className={cn('block h-full rounded-full', p >= 90 ? 'bg-danger' : p >= 80 ? 'bg-warn' : 'bg-fg-2')} style={{ width: `${p}%` }} />
    </span>
  )
}

// ── Attention ───────────────────────────────────────────────────────────────

function AttentionCard() {
  const shown = useShownSides()
  const utils = trpc.useUtils()
  const lang = langFromPath(usePathname())
  const maintenance = trpc.health.maintenance.useQuery({}, { refetchInterval: 60_000 })
  const water = trpc.waterLevel.getLatest.useQuery({}, { refetchInterval: 30_000 })
  const device = trpc.device.getStatus.useQuery({}, { refetchInterval: 10_000 })
  const dataPath = trpc.health.dataPath.useQuery({}, { refetchInterval: 60_000 })
  const enableGuard = trpc.settings.updateDevice.useMutation({
    onSuccess: () => {
      void utils.health.maintenance.invalidate()
      void utils.health.thermal.invalidate()
    },
  })
  const prime = trpc.device.startPriming.useMutation({
    onSuccess: () => void utils.device.getStatus.invalidate(),
  })

  const nowMinute = useNowMinute()
  if (nowMinute == null) return null
  const occupancy = dataPath.data?.occupancy
  const suspectSides = occupancy ? shown.filter(s => occupancy[s] === 'suspect') : []
  const items = attentionItems(maintenance.data, water.data?.level ?? device.data?.waterLevel, nowMinute * 60_000, suspectSides)
  if (items.length === 0) return null
  const priming = device.data?.isPriming ?? false

  return (
    <Card className="gap-0 py-1" tone="warn" data-testid="attention">
      {items.map((it, i) => (
        <div key={it.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5', i > 0 && 'border-t border-line')}>
          <span className="size-1.5 shrink-0 rounded-full bg-warn" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm">{it.title}</span>
            <span className="text-xs text-fg-2">{it.detail}</span>
          </div>
          {it.id === 'pump-stall' && (
            <div className="flex items-center gap-2">
              <Link href={`/${lang}/settings?section=device`} className="text-xs text-fg-2 no-underline hover:underline">Settings</Link>
              <Button size="sm" onClick={() => enableGuard.mutate({ pumpStallProtectionEnabled: true })} disabled={enableGuard.isPending}>
                {enableGuard.isPending ? 'Turning on…' : 'Turn on'}
              </Button>
            </div>
          )}
          {it.id === 'occupancy' && <OccupancyCheck sides={suspectSides} size="sm" />}
          {it.id === 'prime' && (
            <Button size="sm" onClick={() => prime.mutate({})} disabled={prime.isPending || priming}>
              {priming ? 'Priming…' : prime.isPending ? 'Starting…' : 'Start prime'}
            </Button>
          )}
        </div>
      ))}
      {(enableGuard.error || prime.error) && (
        <InlineError className="pb-2 text-xs">{enableGuard.error?.message ?? prime.error?.message}</InlineError>
      )}
    </Card>
  )
}

// ── Tonight ─────────────────────────────────────────────────────────────────

const LANE_H = 64
const HOUR_MIN = 60

function TonightCard({ onJump }: { onJump: (s: DiagSection) => void }) {
  const { sideName } = useSideNames()
  const shown = useShownSides()
  const { unit } = useTemperatureUnit()
  const system = trpc.health.system.useQuery({}, { refetchInterval: 15_000 })
  const scheduler = trpc.health.scheduler.useQuery({ withinHours: 24 }, { refetchInterval: 60_000 })
  const left = trpc.schedules.getAll.useQuery({ side: 'left' }, { staleTime: 60_000 })
  const right = trpc.schedules.getAll.useQuery({ side: 'right' }, { staleTime: 60_000 })
  // Measured bed temperature so far tonight; the window opens at 5 PM, so 24 h always reaches it.
  const history = trpc.health.thermalHistory.useQuery({ range: '24h' }, { staleTime: 60_000, refetchInterval: 60_000 })
  const temps = { left: left.data?.temperature, right: right.data?.temperature }
  // One hover shared by both lanes: the moment under the pointer (epoch ms).
  const [hoverT, setHoverT] = useState<number | null>(null)

  const nowMinute = useNowMinute()
  if (nowMinute == null) return <Skeleton className="h-[220px]" />
  const now = nowMinute * 60_000
  const win = tonightWindow(new Date(now))
  const jobs = scheduler.data?.upcomingJobs as SchedJob[] | undefined
  const next = nextTemperatureJob(jobs, now)
  const tonightJobs = jobsInWindow(jobs, win)
  const drift = system.data?.scheduler?.drift
  const span = win.end - win.start
  const pct = (t: number) => ((t - win.start) / span) * 100
  const nowIn = now >= win.start && now <= win.end
  const fToDisplay = (f: number) => formatSetpointF(f, unit)

  const hourTicks: number[] = []
  for (let h = TONIGHT_START_H; h <= TONIGHT_END_H; h += 4) hourTicks.push(win.start + (h - TONIGHT_START_H) * 3_600_000)

  const midnight = win.midnight.getTime()
  // Curves saved entirely after midnight sit a day earlier on the chart's minute axis.
  const shiftFor = (tl: Array<{ minutes: number }>) => (tl.length && tl[tl.length - 1].minutes < 12 * HOUR_MIN ? -24 * HOUR_MIN : 0)
  const sides = shown.map((side) => {
    const setPoints = nightSetPoints(temps[side], win.day)
    const tl = buildTimeline(setPoints)
    const shift = shiftFor(tl)
    return { side, setPoints, tl, shift, bed: bedTrace(history.data?.points, side, win.midnight, shift) }
  })
  const onLanesPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left - 96
    const w = rect.width - 96
    setHoverT(x < 0 || w <= 0 ? null : win.start + Math.min(1, x / w) * span)
  }
  const hoverPct = hoverT == null ? null : pct(hoverT)
  const fmt = (v: number | null, decimals = 0) => (v == null ? '—' : formatSetpointF(v, unit, { includeUnit: false, decimals }))

  return (
    <Card className="gap-3" data-testid="tonight">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[15px] font-medium">Tonight</span>
        <span className="font-mono text-xs text-fg-2">
          {next
            ? `next: ${next.side === 'left' || next.side === 'right' ? sideName(next.side) : 'Both'} → ${fToDisplay(next.targetTempF as number)} at ${fmtClock(next.nextRun)} · in ${formatCountdown(new Date(next.nextRun as string).getTime() - now)}`
            : 'no temperature changes scheduled'}
        </span>
        <span className="ml-auto flex items-center gap-3 font-mono text-[11px] text-fg-2">
          {history.data?.available.bedTarget && <CurveLegend />}
          {scheduler.data && (
            <span className={cn(drift?.drifted && 'text-warn')}>
              {`${scheduler.data.enabled ? (drift ? (drift.drifted ? 'drifted' : 'in sync') : 'running') : 'off'} · ${scheduler.data.jobCounts.total} jobs`}
            </span>
          )}
          <button
            type="button"
            onClick={() => onJump('scheduler')}
            className="flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-[13px] text-fg-2 hover:text-fg"
          >
            Scheduler
            <ArrowRight size={14} />
          </button>
        </span>
      </div>

      <div
        className="relative grid grid-cols-[84px_minmax(0,1fr)] gap-x-3"
        data-testid="tonight-lanes"
        onPointerMove={onLanesPointerMove}
        onPointerLeave={() => setHoverT(null)}
      >
        {sides.map(({ side, setPoints, tl, shift, bed }) => {
          const range = tl.length ? `${Math.min(...tl.map(p => p.temperature))}–${Math.max(...tl.map(p => p.temperature))}°F` : 'no curve'
          const powerJobs = tonightJobs.filter(j => (j.type === 'power_on' || j.type === 'power_off') && (j.side === side || j.side === 'both'))
          return [
            <div key={`${side}-label`} className="flex flex-col justify-center border-t border-line py-1.5">
              <span className="truncate text-[13px]">{sideName(side)}</span>
              <span className="font-mono text-[10px] text-fg-3">{range}</span>
            </div>,
            <div key={`${side}-lane`} className="relative border-t border-line" style={{ height: LANE_H }} data-testid={`tonight-${side}`}>
              {tl.length > 0 && (
                <CurveChart
                  setPoints={setPoints}
                  height={LANE_H}
                  showAxis={false}
                  grid="neutral"
                  endLabels={false}
                  timeDomain={{ start: TONIGHT_START_H * HOUR_MIN + shift, end: TONIGHT_END_H * HOUR_MIN + shift, step: 4 * HOUR_MIN }}
                  bed={bed}
                  hoverMinutes={hoverT == null ? null : (hoverT - midnight) / 60_000 + shift}
                  onHoverMinutes={m => setHoverT(m == null ? null : midnight + (m - shift) * 60_000)}
                  hoverMarks={false}
                />
              )}
              {powerJobs.map(j => (
                <span
                  key={j.id}
                  className="absolute bottom-0.5 -translate-x-1/2 font-mono text-[9px] text-fg-3"
                  style={{ left: `${pct(new Date(j.nextRun as string).getTime())}%` }}
                >
                  {j.type === 'power_on' ? 'on' : 'off'}
                </span>
              ))}
            </div>,
          ]
        })}

        <div className="flex flex-col justify-center border-t border-line py-1.5">
          <span className="text-[13px]">Pod</span>
        </div>
        <div className="relative h-9 border-t border-line" data-testid="tonight-pod">
          {tonightJobs.filter(isPodLaneJob).map(j => (
            <span
              key={j.id}
              className="absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center"
              style={{ left: `${pct(new Date(j.nextRun as string).getTime())}%` }}
              title={`${podJobLabel(j, sideName)} · ${fmtClock(j.nextRun)}`}
            >
              <span className="size-2 rotate-45 bg-fg-2" />
              <span className="mt-0.5 whitespace-nowrap font-mono text-[9px] text-fg-2">{podJobLabel(j, sideName)}</span>
            </span>
          ))}
        </div>

        <span />
        <div className="relative h-4 font-mono text-[10px] text-fg-3">
          {hourTicks.map(t => (
            <span key={t} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${pct(t)}%` }}>
              {new Date(t).toLocaleTimeString([], { hour: 'numeric' })}
            </span>
          ))}
        </div>

        {nowIn && (
          // Spans the lanes: past the 84px label column + 12px gap, down to above the hour axis.
          <div
            aria-hidden
            data-testid="tonight-now"
            className="pointer-events-none absolute top-0 bottom-4 border-l border-dashed border-fg-2"
            style={{ left: `calc(96px + (100% - 96px) * ${pct(now) / 100})` }}
          >
            <span className="absolute -top-3.5 -translate-x-1/2 font-mono text-[9px] text-fg-2">now</span>
          </div>
        )}

        {hoverT != null && hoverPct != null && (
          <div
            data-testid="tonight-hover"
            className="pointer-events-none absolute top-0 bottom-4 border-l border-fg/35"
            style={{ left: `calc(96px + (100% - 96px) * ${hoverPct / 100})` }}
          >
            <div
              className={cn(
                'absolute top-1 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 rounded-ctl border border-line bg-surface-card px-2.5 py-1.5 font-mono text-[11px] whitespace-nowrap',
                hoverPct > 50 ? 'right-2' : 'left-2',
              )}
            >
              <span className="col-span-2 text-fg-2">{`${fmtClock(new Date(hoverT).toISOString())} · target / bed`}</span>
              {sides.map(({ side, setPoints, shift, bed }) => {
                const at = readAt(setPoints, bed, (hoverT - midnight) / 60_000 + shift)
                return [
                  <span key={`${side}-n`} className="text-fg">{sideName(side)}</span>,
                  <span key={`${side}-v`} className="text-fg">{`${fmt(at.target)} / ${fmt(at.bed, 1)}`}</span>,
                ]
              })}
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

// ── Side cards ──────────────────────────────────────────────────────────────

const SPARK_W = 300
const SPARK_H = 40

function SideSummaryCard({ side: s, onClick }: { side: ThermalSide, onClick: () => void }) {
  const { sideName } = useSideNames()
  const history = trpc.health.thermalHistory.useQuery({ range: '12h' }, { refetchInterval: 60_000 })
  const side = s.side as Side
  const dir = thermalDirection(s)
  const h = history.data
  const bedKey = side === 'left' ? 'leftBed' : 'rightBed'
  const surfaceKey = side === 'left' ? 'leftSurface' : 'rightSurface'
  // Prefer the regulated bed temperature; before thermal_state has history, fall back to the surface reading.
  const key = h?.points.some(p => p[bedKey] != null) ? bedKey : surfaceKey
  const panel = THERMAL_PANELS[0]
  const domain = h ? panelDomain({ ...panel, series: [{ key, label: '' }] }, h.points) : null
  const onAt = s.isPowered && s.poweredOnAt ? new Date(s.poweredOnAt) : null
  const hover = useHoverFraction()
  let readout: { pct: number, label: string } | null = null
  if (h && hover.frac !== null) {
    const t = h.from + hover.frac * (h.to - h.from)
    const p = nearestPoint(h.points, t)
    const v = p && Math.abs(p.t - t) <= h.bucketSec * 3000 ? p[key] : null
    readout = { pct: hover.frac * 100, label: `${fmtClock(new Date(t).toISOString())} · ${fmtF(v)}` }
  }

  return (
    <Card onClick={onClick} className="cursor-pointer gap-2.5 hover:bg-active" data-testid={`side-${side}`}>
      <div className="flex items-baseline gap-2">
        <span className="text-[15px] font-medium">{`${sideName(side)} · ${side}`}</span>
        <span className={cn('ml-auto font-mono text-[11px] tracking-[0.06em]', dir.className)}>{dir.label}</span>
        {s.isPowered && <span className="font-mono text-sm">{fmtF(s.targetTempF)}</span>}
      </div>
      {s.note && <p className="text-xs text-danger">{s.note}</p>}
      <div className="grid grid-cols-3 gap-x-3">
        <KeyValue label="Bed" value={fmtF(s.currentTempF)} size={13} />
        <KeyValue label="Water" value={fmtF(s.waterTempF)} size={13} />
        <KeyValue label="Pump rpm" value={s.pumpRpm == null ? '—' : s.pumpRpm.toLocaleString()} size={13} />
      </div>
      {h && domain
        ? (
            <div className="relative h-10" onPointerMove={hover.onPointerMove} onPointerLeave={hover.onPointerLeave}>
              <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" className="h-10 w-full" aria-label={`${sideName(side)} last 12 hours`}>
                <path
                  transform={`scale(1 ${SPARK_H / 100})`}
                  d={seriesPath(h.points, key, h.from, h.to - h.from, SPARK_W, domain, h.bucketSec * 3000)}
                  fill="none"
                  stroke={side === 'left' ? 'var(--text-1)' : 'var(--stage-rem)'}
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              {readout && <HoverMark pct={readout.pct} label={readout.label} />}
            </div>
          )
        : <div className="h-10" />}
      <span className="font-mono text-[10px] text-fg-3">
        {`12 h${key === surfaceKey && h ? ' · surface' : ''}${onAt ? ` · on since ${onAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : s.isPowered ? '' : ' · off'}`}
      </span>
    </Card>
  )
}
