'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { RotateCcw, SlidersHorizontal } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import { useSideNames } from '@/src/hooks/useSideNames'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { useOnSensorFrame, type SensorFrame } from '@/src/hooks/useSensorStream'
import { Button, Card, HoverMark, InlineError, SegmentedControl, Skeleton, StatusDot, useHoverFraction, type Tone } from '@/src/components/ds'
import { cn } from '@/lib/utils'
import {
  capDeviation, capSumBand, channelsInBaseline, fmtCompact, fmtTimeLeft, parseCapParams, parsePiezoParams,
  peakToPeak, piezoEnvelope, tempZoneMeansC, validity, TEMP_ZONES,
  type CapDeviation, type TempZone,
} from './calibrationSignals'

const CAL_SENSORS = ['piezo', 'capacitance', 'temperature'] as const
type CalSensor = (typeof CAL_SENSORS)[number]
type Side = 'left' | 'right'

const CAL_TONE: Record<string, Tone> = {
  completed: 'ok',
  running: 'warn',
  pending: 'muted',
  failed: 'danger',
  unknown: 'muted',
}

const META: Record<CalSensor, { label: string, sub: string, color: string, windowMs: number, window: string }> = {
  piezo: { label: 'Piezo', sub: 'Heart rate and breathing', color: 'var(--chart-hr)', windowMs: 30_000, window: '-30s' },
  capacitance: { label: 'Capacitance', sub: 'Presence and position', color: 'var(--accent-cool)', windowMs: 30_000, window: '-30s' },
  // Bed temperature only arrives every ~16s, so it needs a longer window to show a line.
  temperature: { label: 'Temperature', sub: 'Bed surface temperature', color: 'var(--accent-warm)', windowMs: 10 * 60_000, window: '-10m' },
}

interface PiezoSample { t: number, samples: number[] }
interface CapSample { t: number, values: number[] }
interface TempSample { t: number, zones: Partial<Record<TempZone, number>> }
interface Buffers { piezo: Record<Side, PiezoSample[]>, cap: Record<Side, CapSample[]>, temp: Record<Side, TempSample[]> }

const emptyBuffers = (): Buffers => ({
  piezo: { left: [], right: [] },
  cap: { left: [], right: [] },
  temp: { left: [], right: [] },
})

function trim<T extends { t: number }>(arr: T[], since: number) {
  let i = 0
  while (i < arr.length && arr[i].t < since) i++
  if (i) arr.splice(0, i)
}

function snapshot(b: Buffers): Buffers {
  return {
    piezo: { left: b.piezo.left.slice(), right: b.piezo.right.slice() },
    cap: { left: b.cap.left.slice(), right: b.cap.right.slice() },
    temp: { left: b.temp.left.slice(), right: b.temp.right.slice() },
  }
}

/**
 * Keeps the last window of each live sensor per side, stamped on arrival, and
 * re-renders a few times a second so the traces scroll smoothly.
 */
function useLiveBuffers() {
  const buf = useRef<Buffers>(emptyBuffers())
  const [view, setView] = useState(() => ({ buffers: emptyBuffers(), now: Date.now() }))

  useOnSensorFrame((frame: SensorFrame) => {
    const t = Date.now()
    const b = buf.current
    if (frame.type === 'piezo-dual') {
      for (const s of ['left', 'right'] as const) {
        const samples = s === 'left' ? frame.left1 : frame.right1
        if (samples?.length) b.piezo[s].push({ t, samples })
        trim(b.piezo[s], t - META.piezo.windowMs)
      }
    }
    else if (frame.type === 'capSense2' || frame.type === 'capSense') {
      for (const s of ['left', 'right'] as const) {
        const v = frame[s]
        b.cap[s].push({ t, values: Array.isArray(v) ? v : [v] })
        trim(b.cap[s], t - META.capacitance.windowMs)
      }
    }
    else if (frame.type === 'bedTemp' || frame.type === 'bedTemp2') {
      for (const s of ['left', 'right'] as const) {
        const zones = s === 'left'
          ? { outer: frame.leftOuterTemp, center: frame.leftCenterTemp, inner: frame.leftInnerTemp }
          : { outer: frame.rightOuterTemp, center: frame.rightCenterTemp, inner: frame.rightInnerTemp }
        const clean: Partial<Record<TempZone, number>> = {}
        for (const z of TEMP_ZONES) if (zones[z] != null) clean[z] = zones[z]
        b.temp[s].push({ t, zones: clean })
        trim(b.temp[s], t - META.temperature.windowMs)
      }
    }
  })

  useEffect(() => {
    const id = setInterval(() => setView({ buffers: snapshot(buf.current), now: Date.now() }), 250)
    return () => clearInterval(id)
  }, [])

  return view
}

/**
 * System → Calibration. One row per sensor: its live signal over the recent
 * window drawn against the band the last calibration set, with quality,
 * samples and how much of the validity window is left alongside.
 */
export function CalibrationPanel() {
  const { side, setSide } = useSide()
  const { leftName, rightName } = useSideNames()
  const utils = trpc.useUtils()
  const [triggering, setTriggering] = useState<CalSensor | null>(null)
  const { buffers, now } = useLiveBuffers()

  const status = trpc.calibration.getStatus.useQuery({ side }, { refetchInterval: 5000 })
  const triggerSingle = trpc.calibration.triggerCalibration.useMutation({
    onSuccess: () => {
      utils.calibration.getStatus.invalidate({ side })
      setTriggering(null)
    },
    onError: () => setTriggering(null),
  })
  const triggerFull = trpc.calibration.triggerFullCalibration.useMutation({
    onSuccess: () => utils.calibration.getStatus.invalidate({ side }),
  })

  const data = status.data
  const anyActive = data && CAL_SENSORS.some(t => data[t]?.status === 'running' || data[t]?.status === 'pending')
  const lastCalibrated = data
    ? CAL_SENSORS.map(t => data[t]?.createdAt).filter(Boolean).map(d => new Date(d as Date).getTime()).sort((a, b) => b - a)[0]
    : undefined

  const sideLabel = (s: Side, name: string) => {
    const dflt = s === 'left' ? 'Left' : 'Right'
    return name === dflt ? dflt : `${name} · ${dflt}`
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5">
        <SegmentedControl
          ariaLabel="Calibration side"
          size="sm"
          value={side}
          options={[{ value: 'left', label: sideLabel('left', leftName) }, { value: 'right', label: sideLabel('right', rightName) }]}
          onChange={setSide}
        />
        {lastCalibrated != null && (
          <span className="font-mono text-xs text-fg-2">
            {'calibrated '}
            {new Date(lastCalibrated).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          </span>
        )}
        <Button
          size="sm"
          icon={SlidersHorizontal}
          className="ml-auto"
          onClick={() => triggerFull.mutate({})}
          disabled={triggerFull.isPending || !!anyActive}
        >
          {triggerFull.isPending ? 'Starting…' : 'Calibrate all'}
        </Button>
      </div>

      {(triggerSingle.error || triggerFull.error) && (
        <Card tone="danger" className="py-3">
          <InlineError>{triggerSingle.error?.message || triggerFull.error?.message}</InlineError>
        </Card>
      )}

      {status.isLoading && CAL_SENSORS.map(type => <Skeleton key={type} className="h-[180px]" data-testid={`cal-${type}-loading`} />)}

      {!status.isLoading && CAL_SENSORS.map((type) => {
        const p = data?.[type]
        const st = p?.status ?? 'unknown'
        const active = st === 'running' || st === 'pending'
        const q = p?.qualityScore
        const v = validity(p?.createdAt, p?.expiresAt, now)
        return (
          <Card key={type} data-testid={`cal-${type}`} className="grid gap-4 @min-[760px]:grid-cols-[180px_minmax(0,1fr)_200px] @min-[760px]:items-center">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-[15px] font-medium">
                <span className="size-2.5 rounded-[3px]" style={{ background: META[type].color }} />
                {META[type].label}
              </div>
              <span className="text-[13px] text-fg-2">{META[type].sub}</span>
              <StatusDot tone={CAL_TONE[st] ?? 'muted'} label={st.toUpperCase()} mono />
            </div>

            <div className="min-w-0">
              {type === 'piezo' && <PiezoSignal side={side} samples={buffers.piezo[side]} params={p?.parameters} now={now} />}
              {type === 'capacitance' && <CapSignal samples={buffers.cap[side]} params={p?.parameters} now={now} />}
              {type === 'temperature' && <TempSignal side={side} samples={buffers.temp[side]} params={p?.parameters} now={now} />}
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-baseline gap-1.5">
                <span className="font-mono text-[26px] leading-none">{q != null ? `${Math.round(q * 100)}%` : '—'}</span>
                <span className="text-xs text-fg-2">quality</span>
              </div>
              <div className="flex justify-between font-mono text-xs text-fg-2">
                <span>{p?.samplesUsed != null ? `${p.samplesUsed.toLocaleString()} samples` : 'no samples'}</span>
                {v && <span className={cn(v.msLeft <= 0 ? 'text-warn' : 'text-fg')}>{fmtTimeLeft(v.msLeft)}</span>}
              </div>
              <ValidityBar remaining={v?.remaining ?? 0} expired={!v || v.msLeft <= 0} />
              {p?.errorMessage && <InlineError className="text-xs">{p.errorMessage}</InlineError>}
              <Button
                variant="ghost"
                size="sm"
                icon={RotateCcw}
                className="-ml-2.5 self-start"
                onClick={() => {
                  setTriggering(type)
                  triggerSingle.mutate({ side, sensorType: type })
                }}
                disabled={triggering === type || active}
              >
                {triggering === type
                  ? 'Starting…'
                  : active ? (st === 'running' ? 'Running…' : 'Pending') : p ? 'Recalibrate' : 'Calibrate'}
              </Button>
            </div>
          </Card>
        )
      })}

      <p className="flex items-center gap-2 text-xs text-fg-2">
        <span className="h-2 w-4 shrink-0 rounded-[2px] bg-active" />
        Shaded band is the range set by the last calibration. Quality is how cleanly the calibration window sat inside it.
      </p>
    </>
  )
}

function ValidityBar({ remaining, expired }: { remaining: number, expired: boolean }) {
  return (
    <div
      role="meter"
      aria-label="Calibration validity left"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(remaining * 100)}
      className="relative h-1 rounded-full bg-active"
    >
      <div className={cn('absolute inset-y-0 left-0 rounded-full', expired ? 'bg-warn' : 'bg-fg-3')} style={{ width: `${remaining * 100}%` }} />
    </div>
  )
}

// ── Signal plots ─────────────────────────────────────────────────────────────

const W = 600
const H = 96

interface PlotProps {
  now: number
  windowMs: number
  window: string
  yMin: number
  yMax: number
  band?: { lo: number, hi: number }
  line?: { y: number, label: string }
  caption: ReactNode
  /** Value under the pointer at time `t`, for the hover readout; null when nothing is there. */
  readout?: (t: number) => string | null
  children: (x: (t: number) => number, y: (v: number) => number) => ReactNode
}

/** Seconds before now, "-12s" or "-3m 05s". */
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 60 ? `-${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `-${s}s`
}

function SignalPlot({ now, windowMs, window, yMin, yMax, band, line, caption, readout, children }: PlotProps) {
  const x = (t: number) => ((t - (now - windowMs)) / windowMs) * W
  const span = yMax - yMin || 1
  const y = (v: number) => H - ((v - yMin) / span) * H
  const hover = useHoverFraction()
  const hoverT = hover.frac === null ? null : now - windowMs + hover.frac * windowMs
  const value = hoverT === null ? null : readout?.(hoverT) ?? null
  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative" onPointerMove={hover.onPointerMove} onPointerLeave={hover.onPointerLeave}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[96px] w-full overflow-hidden rounded-[6px] bg-app">
          {band && (
            <rect x={0} width={W} y={y(band.hi)} height={Math.max(1, y(band.lo) - y(band.hi))} fill="var(--surface-active)" />
          )}
          {line && (
            <line x1={0} x2={W} y1={y(line.y)} y2={y(line.y)} stroke="var(--text-3)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
          )}
          {children(x, y)}
        </svg>
        {hoverT !== null && hover.frac !== null && (
          <HoverMark pct={hover.frac * 100} label={`${ago(now - hoverT)}${value ? ` · ${value}` : ''}`} />
        )}
      </div>
      <div className="grid grid-cols-[auto_1fr_auto] gap-2 font-mono text-[11px] text-fg-3">
        <span>{window}</span>
        <span className="truncate text-center text-fg-2">{caption}</span>
        <span>{line ? line.label : 'now'}</span>
      </div>
    </div>
  )
}

function Waiting({ label }: { label: string }) {
  return (
    <div className="flex h-[96px] items-center justify-center rounded-[6px] bg-app font-mono text-xs text-fg-3">{label}</div>
  )
}

/** The sample stamped closest to `t`, or null when the list is empty. */
function nearestBy<T extends { t: number }>(list: ReadonlyArray<T>, t: number): T | null {
  let best: T | null = null
  for (const s of list) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s
  return best
}

function polyline(points: Array<[number, number]>) {
  return points.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ')
}

function PiezoSignal({ side, samples, params, now }: { side: Side, samples: PiezoSample[], params: unknown, now: number }) {
  const cal = parsePiezoParams(params as Record<string, unknown> | null)
  const env = piezoEnvelope(samples)
  if (env.length < 2) return <Waiting label={`waiting for ${side} piezo…`} />
  const latest = peakToPeak(samples[samples.length - 1]?.samples ?? [])
  const peak = Math.max(...env.map(p => Math.max(Math.abs(p.lo), Math.abs(p.hi))))
  const half = Math.max(peak, cal ? cal.threshold / 2 : 0) * 1.1
  const occupied = cal && latest != null ? latest > cal.threshold : null
  return (
    <SignalPlot
      now={now}
      windowMs={META.piezo.windowMs}
      window={META.piezo.window}
      yMin={-half}
      yMax={half}
      band={cal ? { lo: -cal.noiseRange / 2, hi: cal.noiseRange / 2 } : undefined}
      caption={cal && latest != null
        ? `${occupied ? 'occupied' : 'empty'} · range ${fmtCompact(latest)} of ${fmtCompact(cal.threshold)}`
        : latest != null ? `range ${fmtCompact(latest)} · not calibrated` : '—'}
      readout={(t) => {
        const range = peakToPeak(nearestBy(samples, t)?.samples ?? [])
        return range == null ? null : `range ${fmtCompact(range)}`
      }}
    >
      {(x, y) => {
        const zig = env.flatMap((p): Array<[number, number]> => [[x(p.t), y(p.hi)], [x(p.t), y(p.lo)]])
        return (
          <>
            {cal && (
              <>
                <line x1={0} x2={W} y1={y(cal.threshold / 2)} y2={y(cal.threshold / 2)} stroke="var(--text-3)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
                <line x1={0} x2={W} y1={y(-cal.threshold / 2)} y2={y(-cal.threshold / 2)} stroke="var(--text-3)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
              </>
            )}
            <polyline points={polyline(zig)} fill="none" stroke={META.piezo.color} strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
          </>
        )
      }}
    </SignalPlot>
  )
}

function CapSignal({ samples, params, now }: { samples: CapSample[], params: unknown, now: number }) {
  const cal = parseCapParams(params as Record<string, unknown> | null)
  if (samples.length < 2) return <Waiting label="waiting for capacitance…" />

  if (!cal) {
    // Legacy capSense (Pod 3) or no calibration yet: raw reading, no band.
    const vals = samples.map(s => s.values[0]).filter(v => Number.isFinite(v))
    const lo = Math.min(...vals)
    const hi = Math.max(...vals)
    const pad = (hi - lo) * 0.2 || 1
    return (
      <SignalPlot
        now={now}
        windowMs={META.capacitance.windowMs}
        window={META.capacitance.window}
        yMin={lo - pad}
        yMax={hi + pad}
        caption="raw reading · no capSense2 baseline"
        readout={(t) => {
          const s = nearestBy(samples, t)
          return s ? fmtCompact(s.values[0]) : null
        }}
      >
        {(x, y) => (
          <polyline points={polyline(samples.map(s => [x(s.t), y(s.values[0])]))} fill="none" stroke={META.capacitance.color} strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
        )}
      </SignalPlot>
    )
  }

  const devs = samples
    .map(s => ({ t: s.t, d: capDeviation(s.values, cal) }))
    .filter((s): s is { t: number, d: CapDeviation } => s.d != null)
  if (devs.length < 2) return <Waiting label="waiting for capacitance…" />
  const band = capSumBand(cal)
  const sums = devs.map(s => s.d.sum)
  const yMin = Math.min(-band * 1.5, ...sums)
  const yMax = Math.max(cal.threshold * 1.25, ...sums)
  const last = devs[devs.length - 1].d
  const occupied = last.sum > cal.threshold
  return (
    <SignalPlot
      now={now}
      windowMs={META.capacitance.windowMs}
      window={META.capacitance.window}
      yMin={yMin}
      yMax={yMax}
      band={{ lo: -band, hi: band }}
      line={{ y: cal.threshold, label: 'occupied ↑' }}
      caption={`${occupied ? 'occupied' : 'empty'} · ${channelsInBaseline(last, cal)} of 3 channels in baseline`}
      readout={(t) => {
        const s = nearestBy(devs, t)
        return s ? `${fmtCompact(s.d.sum)} of ${fmtCompact(cal.threshold)}` : null
      }}
    >
      {(x, y) => (
        <>
          {(['A', 'B', 'C'] as const).map(ch => (
            <polyline key={ch} points={polyline(devs.map(s => [x(s.t), y(s.d[ch])]))} fill="none" stroke={META.capacitance.color} strokeOpacity={0.35} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          <polyline points={polyline(devs.map(s => [x(s.t), y(s.d.sum)]))} fill="none" stroke={META.capacitance.color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        </>
      )}
    </SignalPlot>
  )
}

function TempSignal({ side, samples, params, now }: { side: Side, samples: TempSample[], params: unknown, now: number }) {
  const { convert, formatTemp, suffix } = useTemperatureUnit()
  const means = tempZoneMeansC(params as Record<string, unknown> | null, side)
  const pts = samples.filter(s => s.zones.center != null)
  if (pts.length === 0) return <Waiting label="waiting for bed temperature…" />
  const calVals = means ? Object.values(means) : []
  const liveVals = samples.flatMap(s => Object.values(s.zones))
  const all = [...calVals, ...liveVals]
  const lo = Math.min(...all) - 0.5
  const hi = Math.max(...all) + 0.5
  const latest = pts[pts.length - 1].zones.center as number
  const band = calVals.length ? { lo: Math.min(...calVals) - 0.25, hi: Math.max(...calVals) + 0.25 } : undefined
  const spread = band ? (convert(band.hi) ?? 0) - (convert(band.lo) ?? 0) : null
  return (
    <SignalPlot
      now={now}
      windowMs={META.temperature.windowMs}
      window={META.temperature.window}
      yMin={lo}
      yMax={hi}
      band={band}
      caption={means?.center != null
        ? `${formatTemp(latest)} · calibrated ${formatTemp(means.center)}${spread != null ? ` · ${spread.toFixed(1)}° band` : ''}`
        : `${formatTemp(latest)} · not calibrated`}
      readout={(t) => {
        const s = nearestBy(pts, t)
        return s ? formatTemp(s.zones.center as number) : null
      }}
    >
      {(x, y) => (
        <>
          {TEMP_ZONES.map((z) => {
            const zpts = samples.filter(s => s.zones[z] != null)
            // A single reading still draws as a short flat segment up to now.
            const line: Array<[number, number]> = zpts.map(s => [x(s.t), y(s.zones[z] as number)])
            if (line.length) line.push([x(now), line[line.length - 1][1]])
            return (
              <polyline
                key={z}
                aria-label={`${z} zone ${suffix}`}
                points={polyline(line)}
                fill="none"
                stroke={META.temperature.color}
                strokeOpacity={z === 'center' ? 1 : 0.35}
                strokeWidth={z === 'center' ? 1.5 : 1}
                vectorEffect="non-scaling-stroke"
              />
            )
          })}
        </>
      )}
    </SignalPlot>
  )
}
