'use client'

import { HoverMark, useHoverFraction } from '@/src/components/ds/charts'
import { useTimeFormatter } from '@/src/hooks/useTimeFormatter'
import type { SleepEpoch } from '@/src/lib/sleep-stages'

type HeartRateEpoch = Pick<SleepEpoch, 'start' | 'duration' | 'heartRate'>
type MeasuredHeartRateEpoch = HeartRateEpoch & { heartRate: number }

/** Keep real elapsed-time spacing and break the line at every unknown interval. */
export function RecordedHeartRateChart({ epochs, start, end, height = 96 }: {
  epochs: HeartRateEpoch[]
  start: number
  end: number
  height?: number
}) {
  const hover = useHoverFraction()
  const { formatClock } = useTimeFormatter()
  const ordered = epochs.filter(epoch => Number.isFinite(epoch.start) && Number.isFinite(epoch.duration)
    && epoch.duration > 0 && epoch.start < end && epoch.start + epoch.duration > start).sort((first, second) => first.start - second.start)
  const segments: MeasuredHeartRateEpoch[][] = []
  let segment: MeasuredHeartRateEpoch[] = []
  let previous: HeartRateEpoch | undefined
  for (const epoch of ordered) {
    if (epoch.heartRate == null || !Number.isFinite(epoch.heartRate)) {
      previous = undefined
      continue
    }
    if (!previous || epoch.start > previous.start + previous.duration) {
      segment = []
      segments.push(segment)
    }
    segment.push({ ...epoch, heartRate: epoch.heartRate })
    previous = epoch
  }
  const values = segments.flatMap(segment => segment.map(epoch => epoch.heartRate))
  if (!values.length || end <= start) return null
  const lowest = Math.min(...values), highest = Math.max(...values)
  const position = (epoch: MeasuredHeartRateEpoch) => ({
    horizontal: (Math.max(start, epoch.start) - start) / (end - start) * 300,
    vertical: highest === lowest ? height / 2 : 4 + (1 - (epoch.heartRate - lowest) / (highest - lowest)) * (height - 8),
  })
  const hoveredTime = hover.frac == null ? null : Math.min(end - 1, start + hover.frac * (end - start))
  const hovered = hoveredTime == null ? undefined : ordered.find(epoch => hoveredTime >= epoch.start && hoveredTime < epoch.start + epoch.duration)
  let labelTime = hoveredTime
  let reading = 'No reading'
  if (hovered && hovered.heartRate != null && Number.isFinite(hovered.heartRate)) {
    labelTime = hovered.start
    reading = `${Math.round(hovered.heartRate)} bpm`
  }
  const label = `${formatClock(labelTime, { hour: 'numeric', minute: '2-digit' })} · ${reading}`

  return (
    <div className="relative" data-testid="recorded-heart-rate" onPointerMove={hover.onPointerMove} onPointerLeave={hover.onPointerLeave}>
      <svg width="100%" height={height} viewBox={`0 0 300 ${height}`} preserveAspectRatio="none" role="img" aria-label="Recorded heart rate; gaps have no reading">
        {segments.map((segment, index) => {
          const points = segment.map(position)
          if (points.length === 1) return <circle key={index} cx={points[0].horizontal} cy={points[0].vertical} r={1.5} fill="var(--chart-hr)" />
          return <path key={index} d={points.map((point, pointIndex) => `${pointIndex === 0 ? 'M' : 'L'}${point.horizontal.toFixed(1)},${point.vertical.toFixed(1)}`).join(' ')} fill="none" stroke="var(--chart-hr)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        })}
      </svg>
      {hover.frac != null && <HoverMark pct={hover.frac * 100} label={label} />}
    </div>
  )
}
