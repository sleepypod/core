'use client'

import { Card, InlineError, SectionLabel } from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'
import { useTimeFormatter } from '@/src/hooks/useTimeFormatter'

/** Timestamp positioning keeps sparse Watch samples aligned with the pod. */
export function NightHrv({ side, start, end, epochs }: {
  side: 'left' | 'right'
  start: number
  end: number
  epochs: Array<{ start: number, hrv: number | null }>
}) {
  const { formatClock } = useTimeFormatter()
  const watch = trpc.biometrics.getReferenceSamples.useQuery({ side, startDate: new Date(start), endDate: new Date(end), metric: 'hrv_sdnn', limit: 20000 })
  const pod = epochs.filter((e): e is typeof e & { hrv: number } => e.hrv != null && Number.isFinite(e.hrv))
  const samples = (watch.data ?? []).map(r => ({ start: new Date(r.timestamp).getTime(), hrv: r.value }))
  const max = Math.max(1, ...pod.map(p => p.hrv), ...samples.map(p => p.hrv)) * 1.1
  const x = (t: number) => (t - start) / Math.max(1, end - start) * 1000
  const y = (v: number) => 100 - v / max * 90
  return (
    <Card className="gap-2.5 px-5">
      <SectionLabel>Heart rate variability · ms</SectionLabel>
      {watch.error && <InlineError>Could not load Apple Watch HRV.</InlineError>}
      {pod.length || samples.length
        ? (
            <svg viewBox="0 0 1000 110" className="h-28 w-full" preserveAspectRatio="none" role="img" aria-label="Night HRV comparison">
              {pod.map((p, i) => {
                const prev = pod[i - 1]
                return prev && p.start - prev.start <= 10 * 60_000
                  ? <line key={p.start} x1={x(prev.start)} y1={y(prev.hrv)} x2={x(p.start)} y2={y(p.hrv)} stroke="var(--chart-hr)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                  : <circle key={p.start} cx={x(p.start)} cy={y(p.hrv)} r={2} fill="var(--chart-hr)" />
              })}
              {samples.map((p, i) => <circle key={i} cx={x(p.start)} cy={y(p.hrv)} r={3} className="fill-fg"><title>{`${formatClock(p.start)} · Watch SDNN ${Math.round(p.hrv)} ms`}</title></circle>)}
            </svg>
          )
        : <p className="py-6 text-center text-xs text-fg-2">{watch.isLoading ? 'Loading HRV…' : 'No HRV data for this night'}</p>}
      <div className="flex justify-between font-mono text-xs text-fg-3">
        <span>{formatClock(start)}</span>
        <span>{`0–${Math.ceil(max)} ms`}</span>
        <span>{formatClock(end)}</span>
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-fg-2">
        <span>Colored line · sleepypod HRV</span>
        {samples.length > 0 && <span>Dots · Apple Watch SDNN</span>}
      </div>
      {samples.length > 0 && <p className="text-xs text-fg-3">SDNN measures variation between heartbeats. Watch samples are intermittent; the pod may use a different HRV method, so values are not always directly comparable.</p>}
    </Card>
  )
}
