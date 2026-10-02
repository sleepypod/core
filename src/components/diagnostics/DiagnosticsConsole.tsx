'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'
import { useSideNames } from '@/src/hooks/useSideNames'
import { useTrendBuffer } from '@/src/hooks/useTrendBuffer'
import {
  Badge, Card, CardHeader, InlineError, KeyValue, SegmentedControl, Skeleton,
} from '@/src/components/ds'
import { cn } from '@/lib/utils'
import { fmtF, fmtAge, thermalDirection, type ThermalSideSnapshot } from '@/src/components/diagnostics/diagnosticsLogic'
import { DashboardPanel } from './DashboardPanel'
import { ThermalHistoryChart, type ThermalChartData } from './ThermalHistoryChart'
import { availabilityOf, liveToPoints, type LiveThermalSample, type PanelDef } from './thermalHistoryLogic'
import { langFromPath } from '@/src/components/AppShell/navItems'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { CalibrationPanel } from './CalibrationPanel'
import { sideTitle } from './parts'
import { HealthPanel } from './HealthPanel'
import { SchedulerPanel } from './SchedulerPanel'

// Formatting, scheduler-lane, and biometrics/thermal derivations live in
// ./diagnosticsLogic so they can be unit-tested without React/tRPC.

// ── Sections ─────────────────────────────────────────────────────────────────

/** The System pages this console renders; System owns navigation. */
export type DiagSection = 'dashboard' | 'calibration' | 'health' | 'scheduler' | 'thermal'

/** 30 minutes of thermal samples at the 5s poll. */
const THERMAL_HISTORY_POINTS = 360

type ThermalData = inferRouterOutputs<AppRouter>['health']['thermal']
type ThermalSide = ThermalData['sides'][number]
type ThermalHistory = Array<LiveThermalSample & { sides: ThermalSideSnapshot[] }>

/**
 * The pod's diagnostic pages under System (Dashboard, thermal delivery,
 * scheduler, service health, calibration). Kept as one component
 * so the thermal trend buffer survives switching between Dashboard and Thermal.
 */
export function DiagnosticsConsole({ section, onJump }: { section: DiagSection, onJump: (s: DiagSection) => void }) {
  const thermal = trpc.health.thermal.useQuery({}, { refetchInterval: 5000 })
  const history = useTrendBuffer(thermal.data, thermal.dataUpdatedAt, THERMAL_HISTORY_POINTS) as ThermalHistory

  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      {section === 'dashboard' && <DashboardPanel thermal={thermal.data} onJump={onJump} />}
      {section === 'thermal' && <ThermalPanel thermal={thermal} history={history} />}
      {section === 'scheduler' && <SchedulerPanel />}
      {section === 'health' && <HealthPanel onJump={onJump} />}
      {section === 'calibration' && <CalibrationPanel />}
    </div>
  )
}

// ── Overview ─────────────────────────────────────────────────────────────────

interface ThermalQuery {
  data: ThermalData | undefined
  isLoading: boolean
  isFetching: boolean
  error: { message: string } | null
}

// ── Thermal ──────────────────────────────────────────────────────────────────

function ThermalSideCard({ side: s }: { side: ThermalSide }) {
  const { sideName } = useSideNames()
  const side = s.side as 'left' | 'right'
  const dir = thermalDirection(s)
  const stalled = s.verdict === 'stalled'

  return (
    <Card tone={stalled ? 'danger' : undefined} data-testid={`thermal-${side}`}>
      <CardHeader
        title={sideTitle(sideName(side), side)}
        right={<span className={cn('font-mono text-[11px] tracking-[0.06em]', dir.className)}>{dir.label}</span>}
      />
      {s.note && <p className="text-xs text-danger">{s.note}</p>}
      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        <KeyValue label="Target" value={s.isPowered ? fmtF(s.targetTempF) : 'off'} />
        <KeyValue label="Bed" value={fmtF(s.currentTempF)} />
        <KeyValue label="Pump · rpm" value={s.pumpRpm == null ? '—' : s.pumpRpm.toLocaleString()} />
        <KeyValue label="Water" value={fmtF(s.waterTempF)} />
        <KeyValue label="Surface" value={fmtF(s.bedSurfaceTempF)} />
        <KeyValue label="Flow age" value={fmtAge(s.readingAgeSec)} />
      </div>
      {(s.guardBlocked || s.isAlarmVibrating || s.poweredOnAt) && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-2">
          {s.guardBlocked && <Badge className="border-danger-line text-danger">GUARD BLOCKED</Badge>}
          {s.isAlarmVibrating && <Badge className="border-warn-line text-warn">ALARM VIBRATING</Badge>}
          {s.poweredOnAt && <span className="font-mono">{`on since ${new Date(s.poweredOnAt).toLocaleTimeString()}`}</span>}
        </div>
      )}
    </Card>
  )
}

const THERMAL_RANGE_OPTIONS = [
  { value: 'live', label: 'Live' },
  { value: '1h', label: '1 h' },
  { value: '12h', label: '12 h' },
  { value: '24h', label: '24 h' },
  { value: '7d', label: '7 d' },
] as const
type ThermalRangeOption = (typeof THERMAL_RANGE_OPTIONS)[number]['value']

const RANGE_TITLE: Record<Exclude<ThermalRangeOption, 'live'>, string> = {
  '1h': 'Last hour',
  '12h': 'Last 12 hours',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
}

/** Amber warning when the pump-stall guard is off, linking to its setting. */
function PumpStallWarning() {
  const lang = langFromPath(usePathname())
  return (
    <Link
      href={`/${lang}/settings?section=device`}
      className="flex items-center gap-2 text-sm text-fg no-underline hover:underline"
    >
      <span className="size-1.5 rounded-full bg-warn" />
      Pump-stall protection off
    </Link>
  )
}

function ThermalPanel({ thermal, history }: { thermal: ThermalQuery, history: ThermalHistory }) {
  const data = thermal.data
  const { leftName, rightName } = useSideNames()
  const { unit } = useTemperatureUnit()
  const [range, setRange] = useState<ThermalRangeOption>('12h')
  const stored = trpc.health.thermalHistory.useQuery(
    { range: range === 'live' ? '1h' : range },
    { enabled: range !== 'live', refetchInterval: 60_000, placeholderData: prev => prev },
  )

  const toUnit = (f: number) => (unit === 'C' ? Math.round(((f - 32) * 5 / 9) * 10) / 10 : f)
  const formatValue = (panel: PanelDef, v: number | null) => {
    if (v == null) return '—'
    return panel.kind === 'rpm' ? Math.round(v).toLocaleString() : `${toUnit(v).toFixed(1)}°`
  }

  let chart: ThermalChartData | null = null
  if (range === 'live') {
    const points = liveToPoints(history)
    if (points.length > 1) {
      const powerOn = (data?.sides ?? [])
        .filter(s => s.isPowered && s.poweredOnAt)
        .map(s => ({ side: s.side as 'left' | 'right', at: new Date(s.poweredOnAt as string).getTime() }))
      const from = points[0].t
      const to = points[points.length - 1].t
      chart = {
        title: `Live · last ${Math.max(1, Math.round((to - from) / 60_000))} min`,
        points,
        from,
        to,
        gapMs: 20_000,
        powerOn,
        available: availabilityOf(points),
        emptyNote: {},
      }
    }
  }
  else if (stored.data && stored.data.range === range) {
    const h = stored.data
    chart = {
      title: RANGE_TITLE[range],
      points: h.points,
      from: h.from,
      to: h.to,
      gapMs: h.bucketSec * 1000 * 3,
      powerOn: h.powerOn,
      available: h.available,
      emptyNote: {
        bedTarget: h.bedTargetSince == null
          ? 'bed and target history starts recording with this update'
          : `bed and target recorded since ${new Date(h.bedTargetSince).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`,
      },
    }
  }

  const multiDay = chart ? chart.to - chart.from > 36 * 3_600_000 : false
  const tickFormat = (ms: number) => multiDay
    ? new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric' })
    : new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        {data && data.reportsPumpSpeed && !data.pumpStallProtectionEnabled && <PumpStallWarning />}
        {data && (
          <span className="font-mono text-xs text-fg-2">
            {`heatsink ${fmtF(data.heatsinkTempF)} · hub ambient ${fmtF(data.ambientTempF)}`}
          </span>
        )}
        <SegmentedControl
          ariaLabel="Thermal history range"
          size="sm"
          className="ml-auto"
          value={range}
          options={THERMAL_RANGE_OPTIONS}
          onChange={setRange}
        />
      </div>

      {thermal.error && <Card><InlineError>{thermal.error.message}</InlineError></Card>}
      {stored.error && range !== 'live' && <Card><InlineError>{stored.error.message}</InlineError></Card>}

      {chart
        ? (
            <ThermalHistoryChart
              {...chart}
              names={{ left: leftName, right: rightName }}
              formatValue={formatValue}
              formatTemp={toUnit}
              tickFormat={tickFormat}
            />
          )
        : range === 'live'
          ? <Card><p className="text-xs text-fg-3">Collecting samples… (updates every 5s)</p></Card>
          : <Skeleton className="h-[560px]" />}

      {data && (
        <div className="grid items-start gap-3.5 @min-[760px]:grid-cols-2">
          {data.sides.map(s => (
            <ThermalSideCard key={s.side} side={s} />
          ))}
        </div>
      )}
    </>
  )
}
