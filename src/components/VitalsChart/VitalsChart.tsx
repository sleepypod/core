'use client'

import { useCallback, useMemo, useRef, useState } from 'react'

interface DataPoint {
  timestamp: Date
  value: number
}

interface Zone {
  label: string
  min: number
  max: number
  color: string
}

/** Secondary dataset for dual-side comparison overlay */
interface SecondaryDataSet {
  data: DataPoint[]
  color: string
  gradientId: string
  label: string
}

interface VitalsChartProps {
  data: DataPoint[]
  color: string
  gradientId: string
  zones?: Zone[]
  height?: number
  unit: string
  /** Optional label for the primary data line (e.g. "Left") */
  label?: string
  /** Optional secondary dataset rendered as an overlay line for dual-side comparison */
  secondary?: SecondaryDataSet
  /** Format function for x-axis time labels */
  formatTime?: (date: Date) => string
  /** Force y-axis lower bound. When set, auto-fit padding is skipped. */
  yMin?: number
  /** Force y-axis upper bound. When set, auto-fit padding is skipped. */
  yMax?: number
  /** Force x-axis lower bound (ms). Stacked panels share this so events align vertically. */
  xMin?: number
  /** Force x-axis upper bound (ms). */
  xMax?: number
  /** Personal-baseline band lower bound (mean - 1 SD). Draws a faint horizontal band behind the line. */
  baselineMin?: number
  /** Personal-baseline band upper bound (mean + 1 SD). */
  baselineMax?: number
  /** Tightens left padding and tick counts for small-multiple cells. */
  compact?: boolean
}

const PADDING = { top: 8, right: 8, bottom: 24, left: 36 }
const COMPACT_PADDING = { top: 6, right: 4, bottom: 20, left: 22 }
// Break the line on absolute gap > 5 min. Relative thresholds (e.g. 3× median)
// fragment sparse-but-legitimate early-night periods into disconnected stubs;
// 5 min is the natural off-bed / dropout boundary at the pod's sampling cadence.
const GAP_THRESHOLD_MS = 5 * 60 * 1000

function defaultFormatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

/**
 * Lightweight SVG line chart for vitals data.
 * Supports zone backgrounds, tap-to-select, and gradient fill.
 * Matches iOS VitalsChartCard visual style.
 */
export function VitalsChart({
  data,
  color,
  gradientId,
  zones = [],
  height = 180,
  unit,
  label,
  secondary,
  formatTime = defaultFormatTime,
  yMin,
  yMax,
  xMin,
  xMax,
  baselineMin,
  baselineMax,
  compact = false,
}: VitalsChartProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [svgWidth, setSvgWidth] = useState(320)
  const padding = compact ? COMPACT_PADDING : PADDING

  const measureRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setSvgWidth(entry.contentRect.width)
      }
    })
    observer.observe(node)
    setSvgWidth(node.clientWidth)
    return () => observer.disconnect()
  }, [])

  const chartWidth = svgWidth - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom

  const sorted = useMemo(() =>
    [...data].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
  [data])

  const sortedSecondary = useMemo(() =>
    secondary?.data
      ? [...secondary.data].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
      : [],
  [secondary])

  const { minVal, maxVal, minTime, maxTime } = useMemo(() => {
    const allPoints = [...sorted, ...sortedSecondary]
    if (allPoints.length === 0) {
      return {
        minVal: yMin ?? 0,
        maxVal: yMax ?? 100,
        minTime: xMin ?? 0,
        maxTime: xMax ?? 1,
      }
    }

    let lo: number
    let hi: number
    if (yMin != null && yMax != null) {
      lo = yMin
      hi = yMax
    }
    else {
      const values = allPoints.map(d => d.value)
      lo = yMin ?? Math.min(...values)
      hi = yMax ?? Math.max(...values)

      // Include zone ranges in scale (and baseline band so it never clips)
      for (const zone of zones) {
        if (yMin == null) lo = Math.min(lo, zone.min)
        if (yMax == null) hi = Math.max(hi, zone.max)
      }
      if (baselineMin != null && yMin == null) lo = Math.min(lo, baselineMin)
      if (baselineMax != null && yMax == null) hi = Math.max(hi, baselineMax)

      // Add 5% padding only to auto-fit bounds
      const range = hi - lo || 1
      if (yMin == null) lo = lo - range * 0.05
      if (yMax == null) hi = hi + range * 0.05
    }

    const times = allPoints.map(d => d.timestamp.getTime())
    return {
      minVal: lo,
      maxVal: hi,
      minTime: xMin ?? Math.min(...times),
      maxTime: xMax ?? Math.max(...times),
    }
  }, [sorted, sortedSecondary, zones, yMin, yMax, xMin, xMax, baselineMin, baselineMax])

  const scaleX = useCallback((time: number) => {
    const timeRange = maxTime - minTime || 1
    return padding.left + ((time - minTime) / timeRange) * chartWidth
  }, [minTime, maxTime, chartWidth, padding.left])

  const scaleY = useCallback((val: number) => {
    const valRange = maxVal - minVal || 1
    return padding.top + chartHeight - ((val - minVal) / valRange) * chartHeight
  }, [minVal, maxVal, chartHeight, padding.top])

  // Piecewise-linear path between MA points. Bezier smoothing implied
  // inter-sample continuity the data doesn't have and produced impossible curves
  // at sleep-onset / wake transitions.
  const { linePath, areaPath } = useMemo(() => {
    if (sorted.length < 2) return { linePath: '', areaPath: '' }

    const points = sorted.map(d => ({
      x: scaleX(d.timestamp.getTime()),
      y: scaleY(d.value),
      t: d.timestamp.getTime(),
    }))

    const baseline = padding.top + chartHeight
    let line = ''
    let area = ''
    let segmentStart = 0

    for (let i = 0; i < points.length; i++) {
      const curr = points[i]
      const isGap = i > 0 && (curr.t - points[i - 1].t) > GAP_THRESHOLD_MS

      if (i === 0 || isGap) {
        if (isGap) {
          const prev = points[i - 1]
          area += ` L ${prev.x},${baseline} L ${points[segmentStart].x},${baseline} Z`
          segmentStart = i
        }
        line += `${line ? ' ' : ''}M ${curr.x},${curr.y}`
        area += `${area ? ' ' : ''}M ${curr.x},${curr.y}`
      }
      else {
        line += ` L ${curr.x},${curr.y}`
        area += ` L ${curr.x},${curr.y}`
      }
    }

    const last = points[points.length - 1]
    area += ` L ${last.x},${baseline} L ${points[segmentStart].x},${baseline} Z`

    return { linePath: line, areaPath: area }
  }, [sorted, scaleX, scaleY, chartHeight, padding.top])

  const secondaryLinePath = useMemo(() => {
    if (sortedSecondary.length < 2) return ''
    const points = sortedSecondary.map(d => ({
      x: scaleX(d.timestamp.getTime()),
      y: scaleY(d.value),
      t: d.timestamp.getTime(),
    }))
    let line = ''
    for (let i = 0; i < points.length; i++) {
      const curr = points[i]
      const isGap = i > 0 && (curr.t - points[i - 1].t) > GAP_THRESHOLD_MS
      if (i === 0 || isGap) {
        line += `${line ? ' ' : ''}M ${curr.x},${curr.y}`
      }
      else {
        line += ` L ${curr.x},${curr.y}`
      }
    }
    return line
  }, [sortedSecondary, scaleX, scaleY])

  // X-axis tick labels (4 ticks, or 2 in compact mode)
  const xTicks = useMemo(() => {
    if (sorted.length < 2) return []
    const count = compact ? 2 : 4
    const ticks: { x: number, label: string }[] = []
    for (let i = 0; i < count; i++) {
      const t = minTime + (i / (count - 1)) * (maxTime - minTime)
      ticks.push({ x: scaleX(t), label: formatTime(new Date(t)) })
    }
    return ticks
  }, [sorted.length, minTime, maxTime, scaleX, formatTime, compact])

  // Y-axis tick labels (3 ticks, or 2 in compact mode)
  const yTicks = useMemo(() => {
    const count = compact ? 2 : 3
    const ticks: { y: number, label: string }[] = []
    for (let i = 0; i < count; i++) {
      const v = minVal + (i / (count - 1)) * (maxVal - minVal)
      ticks.push({ y: scaleY(v), label: Math.round(v).toString() })
    }
    return ticks
  }, [minVal, maxVal, scaleY, compact])

  const handleClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (sorted.length === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const clickX = e.clientX - rect.left

    // Find nearest data point
    let closest = 0
    let closestDist = Infinity
    for (let i = 0; i < sorted.length; i++) {
      const px = scaleX(sorted[i].timestamp.getTime())
      const dist = Math.abs(px - clickX)
      if (dist < closestDist) {
        closestDist = dist
        closest = i
      }
    }

    // Toggle off if tapping same point
    setSelectedIndex(prev => prev === closest ? null : closest)
  }, [sorted, scaleX])

  const handleTouch = useCallback((e: React.TouchEvent<SVGSVGElement>) => {
    if (sorted.length === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const touchX = e.touches[0].clientX - rect.left

    let closest = 0
    let closestDist = Infinity
    for (let i = 0; i < sorted.length; i++) {
      const px = scaleX(sorted[i].timestamp.getTime())
      const dist = Math.abs(px - touchX)
      if (dist < closestDist) {
        closestDist = dist
        closest = i
      }
    }
    setSelectedIndex(closest)
  }, [sorted, scaleX])

  const selectedPoint = selectedIndex !== null ? sorted[selectedIndex] : null

  // Find the closest secondary point to the selected timestamp for comparison display
  const selectedSecondaryPoint = useMemo(() => {
    if (selectedPoint == null || sortedSecondary.length === 0) return null
    const targetTime = selectedPoint.timestamp.getTime()
    let closest = sortedSecondary[0]
    let closestDist = Math.abs(closest.timestamp.getTime() - targetTime)
    for (const pt of sortedSecondary) {
      const dist = Math.abs(pt.timestamp.getTime() - targetTime)
      if (dist < closestDist) {
        closestDist = dist
        closest = pt
      }
    }
    // Only show if within 10 minutes of the primary point
    return closestDist < 10 * 60 * 1000 ? closest : null
  }, [selectedPoint, sortedSecondary])

  if (sorted.length === 0 && sortedSecondary.length === 0) {
    return (
      <div className="flex items-center justify-center text-zinc-500 text-sm" style={{ height }}>
        No data available
      </div>
    )
  }

  return (
    <div ref={measureRef} className="w-full">
      {/* Selected value display */}
      {selectedPoint && (
        <div className="flex justify-end mb-1 gap-3">
          <div className="text-xs">
            {label && (
              <span className="text-zinc-500 mr-1">
                {label}
                :
              </span>
            )}
            <span style={{ color }} className="font-medium">
              {Math.round(selectedPoint.value)}
              {' '}
              {unit}
            </span>
            <span className="text-zinc-500 ml-1.5">
              {formatTime(selectedPoint.timestamp)}
            </span>
          </div>
          {secondary && selectedSecondaryPoint && (
            <div className="text-xs">
              <span className="text-zinc-500 mr-1">
                {secondary.label}
                :
              </span>
              <span style={{ color: secondary.color }} className="font-medium">
                {Math.round(selectedSecondaryPoint.value)}
                {' '}
                {unit}
              </span>
            </div>
          )}
        </div>
      )}

      <svg
        ref={svgRef}
        width={svgWidth}
        height={height}
        className="touch-none select-none"
        onClick={handleClick}
        onTouchStart={handleTouch}
        onTouchMove={handleTouch}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0.04" />
          </linearGradient>
          {secondary && (
            <linearGradient id={secondary.gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={secondary.color} stopOpacity="0.18" />
              <stop offset="100%" stopColor={secondary.color} stopOpacity="0.04" />
            </linearGradient>
          )}
        </defs>

        {/* Personal baseline band (mean ± 1 SD). Sole reference behind the line —
            population zones have been retired for sleep view. */}
        {baselineMin != null && baselineMax != null && baselineMax > baselineMin && (
          <>
            <rect
              x={padding.left}
              y={scaleY(baselineMax)}
              width={chartWidth}
              height={Math.max(0, scaleY(baselineMin) - scaleY(baselineMax))}
              fill={color}
              opacity="0.15"
            />
            <line
              x1={padding.left}
              y1={scaleY(baselineMax)}
              x2={padding.left + chartWidth}
              y2={scaleY(baselineMax)}
              stroke={color}
              strokeWidth="0.5"
              strokeDasharray="3,3"
              opacity="0.4"
            />
            <line
              x1={padding.left}
              y1={scaleY(baselineMin)}
              x2={padding.left + chartWidth}
              y2={scaleY(baselineMin)}
              stroke={color}
              strokeWidth="0.5"
              strokeDasharray="3,3"
              opacity="0.4"
            />
          </>
        )}

        {/* Zone backgrounds */}
        {zones.map((zone) => {
          const y1 = scaleY(zone.max)
          const y2 = scaleY(zone.min)
          return (
            <rect
              key={zone.label}
              x={padding.left}
              y={y1}
              width={chartWidth}
              height={Math.max(0, y2 - y1)}
              fill={zone.color}
            />
          )
        })}

        {/* Y-axis grid lines and labels */}
        {yTicks.map(tick => (
          <g key={tick.label}>
            <line
              x1={padding.left}
              y1={tick.y}
              x2={padding.left + chartWidth}
              y2={tick.y}
              stroke="rgb(63 63 70)" /* zinc-700 */
              strokeWidth="0.5"
            />
            <text
              x={padding.left - 6}
              y={tick.y + 3}
              textAnchor="end"
              fill="rgb(113 113 122)" /* zinc-500 */
              fontSize="11"
            >
              {tick.label}
            </text>
          </g>
        ))}

        {/* Area fill */}
        {areaPath && (
          <path d={areaPath} fill={`url(#${gradientId})`} />
        )}

        {/* Data line (primary) */}
        {linePath && (
          <path
            d={linePath}
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* Secondary data line (dual-side comparison overlay) */}
        {secondary && secondaryLinePath && (
          <path
            d={secondaryLinePath}
            fill="none"
            stroke={secondary.color}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="6,3"
            opacity="0.7"
          />
        )}

        {/* Selected point indicator */}
        {selectedPoint && (
          <g>
            <line
              x1={scaleX(selectedPoint.timestamp.getTime())}
              y1={padding.top}
              x2={scaleX(selectedPoint.timestamp.getTime())}
              y2={padding.top + chartHeight}
              stroke="white"
              strokeWidth="1"
              opacity="0.3"
            />
            <circle
              cx={scaleX(selectedPoint.timestamp.getTime())}
              cy={scaleY(selectedPoint.value)}
              r="4"
              fill={color}
              stroke="white"
              strokeWidth="1.5"
            />
          </g>
        )}

        {/* Secondary selected point indicator */}
        {selectedSecondaryPoint && secondary && (
          <circle
            cx={scaleX(selectedSecondaryPoint.timestamp.getTime())}
            cy={scaleY(selectedSecondaryPoint.value)}
            r="3.5"
            fill={secondary.color}
            stroke="white"
            strokeWidth="1.5"
            opacity="0.8"
          />
        )}

        {/* X-axis labels */}
        {xTicks.map((tick, i) => (
          <text
            key={i}
            x={tick.x}
            y={height - 4}
            textAnchor="middle"
            fill="rgb(113 113 122)" /* zinc-500 */
            fontSize="11"
          >
            {tick.label}
          </text>
        ))}
      </svg>
    </div>
  )
}
