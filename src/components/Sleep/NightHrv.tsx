'use client'

import { useEffect, useRef, useState } from 'react'
import { Card, InlineError, SectionLabel } from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'
import { useTimeFormatter } from '@/src/hooks/useTimeFormatter'

interface NightVitalsProps {
  side: 'left' | 'right'
  start: number
  end: number
  epochs: Array<{ start: number, hrv: number | null, heartRate?: number | null }>
}

export function NightHrv({ side, start, end, epochs }: NightVitalsProps) {
  const watch = trpc.biometrics.getReferenceSamples.useQuery({ side, startDate: new Date(start), endDate: new Date(end), metric: 'hrv_sdnn', limit: 20000 })
  return <NightVitalPlot start={start} end={end} metric="HRV" pod={epochs.flatMap(e => e.hrv == null ? [] : [{ start: e.start, hrv: e.hrv }])} samples={(watch.data ?? []).map(r => ({ start: new Date(r.timestamp).getTime(), hrv: r.value }))} error={!!watch.error} loading={watch.isLoading} />
}

export function NightHeartRate({ side, start, end, epochs }: NightVitalsProps) {
  const watch = trpc.biometrics.getReferenceVitals.useQuery({ side, startDate: new Date(start), endDate: new Date(end), limit: 20000 })
  return <NightVitalPlot start={start} end={end} metric="heart rate" pod={epochs.flatMap(e => e.heartRate == null ? [] : [{ start: e.start, hrv: e.heartRate }])} samples={(watch.data ?? []).map(r => ({ start: new Date(r.timestamp).getTime(), hrv: r.heartRate }))} error={!!watch.error} loading={watch.isLoading} />
}

/** A pixel-matched viewBox keeps sample markers round at every container width. */
function NightVitalPlot({ start, end, metric, pod, samples, error, loading }: {
  start: number
  end: number
  metric: 'HRV' | 'heart rate'
  pod: Array<{ start: number, hrv: number }>
  samples: Array<{ start: number, hrv: number }>
  error: boolean
  loading: boolean
}) {
  const { formatClock } = useTimeFormatter()
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1000)
  const [hover, setHover] = useState<{ start: number, hrv: number } | null>(null)
  useEffect(() => {
    if (!container.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWidth(entry.contentRect.width)
    })
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  const isHrv = metric === 'HRV'
  const unit = isHrv ? 'ms' : 'bpm'
  const watchLabel = isHrv ? 'Apple Watch SDNN' : 'Apple Watch heart rate'
  const max = Math.max(1, ...pod.map(p => p.hrv), ...samples.map(p => p.hrv)) * 1.1
  const x = (t: number) => (t - start) / Math.max(1, end - start) * width
  const y = (v: number) => 100 - v / max * 90
  return (
    <Card className="gap-2.5 px-5">
      <SectionLabel right={!isHrv && pod.length > 0 ? <span className="font-mono">{`min ${Math.round(Math.min(...pod.map(p => p.hrv)))} · avg ${Math.round(pod.reduce((sum, p) => sum + p.hrv, 0) / pod.length)} · max ${Math.round(Math.max(...pod.map(p => p.hrv)))} bpm`}</span> : undefined}>{isHrv ? 'Heart rate variability · ms' : 'Heart rate through the night · bpm'}</SectionLabel>
      {error && <InlineError>{`Could not load Apple Watch ${metric}.`}</InlineError>}
      <div
        ref={container}
        className="relative"
        data-testid={isHrv ? 'night-hrv-plot' : 'night-hr-plot'}
        onPointerLeave={() => setHover(null)}
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect()
          const time = start + Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width))) * (end - start)
          setHover(pod.reduce<typeof hover>((best, p) => best === null || Math.abs(p.start - time) < Math.abs(best.start - time) ? p : best, null))
        }}
      >
        {pod.length || samples.length
          ? (
              <svg viewBox={`0 0 ${width} 110`} className="h-[110px] w-full" role="img" aria-label={`Night ${metric} comparison`}>
                {pod.map((p, i) => {
                  const prev = pod[i - 1]
                  return prev && p.start - prev.start <= 10 * 60_000
                    ? <line key={p.start} x1={x(prev.start)} y1={y(prev.hrv)} x2={x(p.start)} y2={y(p.hrv)} stroke="var(--chart-hr)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                    : <circle key={p.start} cx={x(p.start)} cy={y(p.hrv)} r={2} fill="var(--chart-hr)" />
                })}
                {samples.map((p, i) => {
                  const prev = samples[i - 1]
                  return (
                    <g key={i}>
                      {!isHrv && prev && p.start - prev.start <= 15 * 60_000 && <line x1={x(prev.start)} y1={y(prev.hrv)} x2={x(p.start)} y2={y(p.hrv)} stroke="var(--status-ok)" strokeDasharray="3 3" strokeWidth={1.5} />}
                      <circle cx={x(p.start)} cy={y(p.hrv)} r={isHrv ? 5 : 2.5} fill="var(--status-ok)" stroke="var(--surface)" strokeWidth={1}><title>{`${formatClock(p.start)} · ${watchLabel} ${Math.round(p.hrv)} ${unit}`}</title></circle>
                    </g>
                  )
                })}
              </svg>
            )
          : <p className="py-6 text-center text-xs text-fg-2">{loading ? `Loading ${metric}…` : `No ${metric} data for this night`}</p>}
        {hover && <div data-testid="chart-hover" className="pointer-events-none absolute right-0 top-0 rounded bg-surface px-2 py-1 font-mono text-xs">{`${formatClock(hover.start)} · ${Math.round(hover.hrv)} ${unit}`}</div>}
      </div>
      <div className="flex justify-between font-mono text-xs text-fg-3">
        <span>{formatClock(start)}</span>
        <span>{`0–${Math.ceil(max)} ${unit}`}</span>
        <span>{formatClock(end)}</span>
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-fg-2">
        <span>{`Colored line · sleepypod ${metric}`}</span>
        {samples.length > 0 && (
          <span className="inline-flex items-center gap-1.5 text-fg">
            <span className="size-2.5 rounded-full bg-ok" aria-hidden="true" />
            {`${watchLabel} · ${samples.length} samples`}
          </span>
        )}
      </div>
      {isHrv && samples.length > 0 && <p className="text-xs text-fg-3">Watch SDNN measures variation between normal heartbeats. Sleepypod’s HRV is a window-based IBI variability index. They use different calculations and cannot be directly converted; compare their trends, not their absolute values.</p>}
    </Card>
  )
}
