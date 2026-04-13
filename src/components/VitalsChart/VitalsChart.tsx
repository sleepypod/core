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
  average?: number | null
}

interface VitalsChartProps {
  data: DataPoint[]
  color: string
  gradientId: string
  zones?: Zone[]
  average?: number | null
  height?: number
  unit: string
  /** Optional label for the primary data line (e.g. "Left") */
  label?: string
  /** Optional secondary dataset rendered as an overlay line for dual-side comparison */
  secondary?: SecondaryDataSet
  /** Format function for x-axis time labels */
  formatTime?: (date: Date) => string
}

const PADDING = { top: 8, right: 8, bottom: 24, left: 36 }

function defaultFormatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

/**
 * Lightweight SVG line chart for vitals data.
 * Supports zone backgrounds, average line, tap-to-select, and gradient fill.
 * Matches iOS VitalsChartCard visual style.
 */
export function VitalsChart({
  data,
  color,
  gradientId,
  zones = [],
  average,
  height = 180,
  unit,
  label,
  secondary,
  formatTime = defaultFormatTime,
}: VitalsChartProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [svgWidth, setSvgWidth] = useState(320)

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

  const chartWidth = svgWidth - PADDING.left - PADDING.right
  const chartHeight = height - PADDING.top - PADDING.bottom

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
      return { minVal: 0, maxVal: 100, minTime: 0, maxTime: 1 }
    }
    const values = allPoints.map(d => d.value)
    let lo = Math.min(...values)
    let hi = Math.max(...values)

    // Include zone ranges in scale
    for (const zone of zones) {
      lo = Math.min(lo, zone.min)
      hi = Math.max(hi, zone.max)
    }

    // Add 5% padding
    const range = hi - lo || 1
    lo = lo - range * 0.05
    hi = hi + range * 0.05

    const times = allPoints.map(d => d.timestamp.getTime())
    return {
      minVal: lo,
      maxVal: hi,
      minTime: Math.min(...times),
      maxTime: Math.max(...times),
    }
  }, [sorted, sortedSecondary, zones])

  const scaleX = useCallback((time: number) => {
    const timeRange = maxTime - minTime || 1
    return PADDING.left + ((time - minTime) / timeRange) * chartWidth
  }, [minTime, maxTime, chartWidth])

  const scaleY = useCallback((val: number) => {
    const valRange = maxVal - minVal || 1
    return PADDING.top + chartHeight - ((val - minVal) / valRange) * chartHeight
  }, [minVal, maxVal, chartHeight])

  // Build SVG path with Catmull-Rom-like smoothing via quadratic beziers
  const { linePath, areaPath } = useMemo(() => {
    if (sorted.length < 2) return { linePath: '', areaPath: '' }

    const points = sorted.map(d => ({
      x: scaleX(d.timestamp.getTime()),
      y: scaleY(d.value),
    }))

    // Simple line path
    let line = `M ${points[0].x},${points[0].y}`
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1]
      const curr = points[i]
      const cpx = (prev.x + curr.x) / 2
      line += ` Q ${cpx},${prev.y} ${curr.x},${curr.y}`
    }

    const baseline = PADDING.top + chartHeight
    const area = line + ` L ${points[points.length - 1].x},${baseline} L ${points[0].x},${baseline} Z`

    return { linePath: line, areaPath: area }
  }, [sorted, scaleX, scaleY, chartHeight])

  // Build secondary line path (no area fill — just a line overlay)
  const secondaryLinePath = useMemo(() => {
    if (sortedSecondary.length < 2) return ''
    const points = sortedSecondary.map(d => ({
      x: scaleX(d.timestamp.getTime()),
      y: scaleY(d.value),
    }))
    let line = `M ${points[0].x},${points[0].y}`
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1]
      const curr = points[i]
      const cpx = (prev.x + curr.x) / 2
      line += ` Q ${cpx},${prev.y} ${curr.x},${curr.y}`
    }
    return line
  }, [sortedSecondary, scaleX, scaleY])

  // X-axis tick labels (4 ticks)
  const xTicks = useMemo(() => {
    if (sorted.length < 2) return []
    const count = 4
    const ticks: { x: number, label: string }[] = []
    for (let i = 0; i < count; i++) {
      const t = minTime + (i / (count - 1)) * (maxTime - minTime)
      ticks.push({ x: scaleX(t), label: formatTime(new Date(t)) })
    }
    return ticks
  }, [sorted.length, minTime, maxTime, scaleX, formatTime])

  // Y-axis tick labels (3 ticks)
  const yTicks = useMemo(() => {
    const count = 3
    const ticks: { y: number, label: string }[] = []
    for (let i = 0; i < count; i++) {
      const v = minVal + (i / (count - 1)) * (maxVal - minVal)
      ticks.push({ y: scaleY(v), label: Math.round(v).toString() })
    }
    return ticks
  }, [minVal, maxVal, scaleY])

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
            <stop offset="0%" stopColor={color} stopOpacity="0.2" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
          {secondary && (
            <linearGradient id={secondary.gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={secondary.color} stopOpacity="0.12" />
              <stop offset="100%" stopColor={secondary.color} stopOpacity="0.02" />
            </linearGradient>
          )}
        </defs>

        {/* Zone backgrounds */}
        {zones.map((zone) => {
          const y1 = scaleY(zone.max)
          const y2 = scaleY(zone.min)
          return (
            <rect
              key={zone.label}
              x={PADDING.left}
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
              x1={PADDING.left}
              y1={tick.y}
              x2={PADDING.left + chartWidth}
              y2={tick.y}
              stroke="rgb(63 63 70)" /* zinc-700 */
              strokeWidth="0.5"
            />
            <text
              x={PADDING.left - 6}
              y={tick.y + 3}
              textAnchor="end"
              fill="rgb(113 113 122)" /* zinc-500 */
              fontSize="10"
            >
              {tick.label}
            </text>
          </g>
        ))}

        {/* Average dashed line */}
        {average != null && (
          <g>
            <line
              x1={PADDING.left}
              y1={scaleY(average)}
              x2={PADDING.left + chartWidth}
              y2={scaleY(average)}
              stroke={color}
              strokeWidth="1"
              strokeDasharray="5,5"
              opacity="0.3"
            />
            <text
              x={PADDING.left + 2}
              y={scaleY(average) - 4}
              fill={color}
              fontSize="8"
              opacity="0.5"
            >
              avg
            </text>
          </g>
        )}

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

        {/* Secondary average dashed line */}
        {secondary?.average != null && (
          <g>
            <line
              x1={PADDING.left}
              y1={scaleY(secondary.average)}
              x2={PADDING.left + chartWidth}
              y2={scaleY(secondary.average)}
              stroke={secondary.color}
              strokeWidth="1"
              strokeDasharray="3,3"
              opacity="0.2"
            />
          </g>
        )}

        {/* Selected point indicator */}
        {selectedPoint && (
          <g>
            <line
              x1={scaleX(selectedPoint.timestamp.getTime())}
              y1={PADDING.top}
              x2={scaleX(selectedPoint.timestamp.getTime())}
              y2={PADDING.top + chartHeight}
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
            fontSize="10"
          >
            {tick.label}
          </text>
        ))}
      </svg>
    </div>
  )
}
