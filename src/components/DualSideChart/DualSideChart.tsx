'use client'

import { useCallback, useMemo, useRef, useState } from 'react'

// ── Types ──

export interface DataPoint {
  timestamp: Date
  value: number
}

export interface Zone {
  label: string
  min: number
  max: number
  color: string
}

export interface DualSideChartProps {
  /** Left side data series */
  leftData: DataPoint[]
  /** Right side data series */
  rightData: DataPoint[]
  /** Unit label for tooltip display (e.g. "BPM", "ms", "°F") */
  unit: string
  /** Unique ID prefix for SVG gradient definitions */
  gradientId: string
  /** Optional zone backgrounds (e.g. normal/elevated ranges) */
  zones?: Zone[]
  /** Optional average line value (uses primary side average) */
  average?: number | null
  /** Chart height in pixels (default 200) */
  height?: number
  /** Left side color (default sky-400: #38bdf8) */
  leftColor?: string
  /** Right side color (default amber-400: #fbbf24) */
  rightColor?: string
  /** Left side label (default "Left") */
  leftLabel?: string
  /** Right side label (default "Right") */
  rightLabel?: string
  /** Format function for x-axis time labels */
  formatTime?: (date: Date) => string
  /** Format function for tooltip values (default: Math.round) */
  formatValue?: (value: number) => string
}

// ── Constants ──

const PADDING = { top: 8, right: 8, bottom: 24, left: 36 }
const LEFT_COLOR_DEFAULT = '#38bdf8'  // sky-400
const RIGHT_COLOR_DEFAULT = '#fbbf24' // amber-400

function defaultFormatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

function defaultFormatValue(value: number): string {
  return Math.round(value).toString()
}

// ── Component ──

/**
 * Reusable dual-series SVG line chart for comparing left/right side data.
 *
 * Features:
 * - Two data series with distinct colors and gradient fills
 * - Color-coded legend with side labels
 * - Tap/click to select nearest point with tooltip showing side + value
 * - Zone backgrounds for range indicators
 * - Optional average line
 * - Responsive width via ResizeObserver
 * - Touch-friendly interactions for mobile
 *
 * Follows the VitalsChart pattern — lightweight custom SVG, no charting library.
 */
export function DualSideChart({
  leftData,
  rightData,
  unit,
  gradientId,
  zones = [],
  average,
  height = 200,
  leftColor = LEFT_COLOR_DEFAULT,
  rightColor = RIGHT_COLOR_DEFAULT,
  leftLabel = 'Left',
  rightLabel = 'Right',
  formatTime = defaultFormatTime,
  formatValue = defaultFormatValue,
}: DualSideChartProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [svgWidth, setSvgWidth] = useState(320)
  const [selectedPoint, setSelectedPoint] = useState<{
    side: 'left' | 'right'
    index: number
    point: DataPoint
  } | null>(null)

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

  // Sort both series by timestamp
  const sortedLeft = useMemo(() =>
    [...leftData].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
  [leftData])

  const sortedRight = useMemo(() =>
    [...rightData].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
  [rightData])

  // Compute unified scale across both series
  const { minVal, maxVal, minTime, maxTime } = useMemo(() => {
    const allPoints = [...sortedLeft, ...sortedRight]
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

    const timestamps = allPoints.map(d => d.timestamp.getTime())
    return {
      minVal: lo,
      maxVal: hi,
      minTime: Math.min(...timestamps),
      maxTime: Math.max(...timestamps),
    }
  }, [sortedLeft, sortedRight, zones])

  const scaleX = useCallback((time: number) => {
    const timeRange = maxTime - minTime || 1
    return PADDING.left + ((time - minTime) / timeRange) * chartWidth
  }, [minTime, maxTime, chartWidth])

  const scaleY = useCallback((val: number) => {
    const valRange = maxVal - minVal || 1
    return PADDING.top + chartHeight - ((val - minVal) / valRange) * chartHeight
  }, [minVal, maxVal, chartHeight])

  // Build SVG paths with smooth quadratic bezier curves
  const buildPaths = useCallback((data: DataPoint[]) => {
    if (data.length < 2) return { linePath: '', areaPath: '' }

    const points = data.map(d => ({
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

    const baseline = PADDING.top + chartHeight
    const area = line + ` L ${points[points.length - 1].x},${baseline} L ${points[0].x},${baseline} Z`

    return { linePath: line, areaPath: area }
  }, [scaleX, scaleY, chartHeight])

  const leftPaths = useMemo(() => buildPaths(sortedLeft), [buildPaths, sortedLeft])
  const rightPaths = useMemo(() => buildPaths(sortedRight), [buildPaths, sortedRight])

  // X-axis tick labels (4 ticks)
  const xTicks = useMemo(() => {
    const allPoints = [...sortedLeft, ...sortedRight]
    if (allPoints.length < 2) return []
    const count = 4
    const ticks: { x: number; label: string }[] = []
    for (let i = 0; i < count; i++) {
      const t = minTime + (i / (count - 1)) * (maxTime - minTime)
      ticks.push({ x: scaleX(t), label: formatTime(new Date(t)) })
    }
    return ticks
  }, [sortedLeft.length, sortedRight.length, minTime, maxTime, scaleX, formatTime])

  // Y-axis tick labels (3 ticks)
  const yTicks = useMemo(() => {
    const count = 3
    const ticks: { y: number; label: string }[] = []
    for (let i = 0; i < count; i++) {
      const v = minVal + (i / (count - 1)) * (maxVal - minVal)
      ticks.push({ y: scaleY(v), label: Math.round(v).toString() })
    }
    return ticks
  }, [minVal, maxVal, scaleY])

  // Find nearest point from either series on click/touch
  const findNearest = useCallback((clientX: number, rect: DOMRect) => {
    const clickX = clientX - rect.left

    let bestSide: 'left' | 'right' = 'left'
    let bestIndex = 0
    let bestDist = Infinity

    for (let i = 0; i < sortedLeft.length; i++) {
      const px = scaleX(sortedLeft[i].timestamp.getTime())
      const dist = Math.abs(px - clickX)
      if (dist < bestDist) {
        bestDist = dist
        bestIndex = i
        bestSide = 'left'
      }
    }

    for (let i = 0; i < sortedRight.length; i++) {
      const px = scaleX(sortedRight[i].timestamp.getTime())
      const dist = Math.abs(px - clickX)
      if (dist < bestDist) {
        bestDist = dist
        bestIndex = i
        bestSide = 'right'
      }
    }

    const point = bestSide === 'left' ? sortedLeft[bestIndex] : sortedRight[bestIndex]
    return { side: bestSide, index: bestIndex, point }
  }, [sortedLeft, sortedRight, scaleX])

  const handleClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (sortedLeft.length === 0 && sortedRight.length === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const result = findNearest(e.clientX, rect)

    // Toggle off if tapping same point
    setSelectedPoint(prev =>
      prev?.side === result.side && prev?.index === result.index ? null : result,
    )
  }, [sortedLeft.length, sortedRight.length, findNearest])

  const handleTouch = useCallback((e: React.TouchEvent<SVGSVGElement>) => {
    if (sortedLeft.length === 0 && sortedRight.length === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const result = findNearest(e.touches[0].clientX, rect)
    setSelectedPoint(result)
  }, [sortedLeft.length, sortedRight.length, findNearest])

  const hasData = sortedLeft.length > 0 || sortedRight.length > 0

  if (!hasData) {
    return (
      <div className="flex items-center justify-center text-zinc-500 text-sm" style={{ height }}>
        No data available
      </div>
    )
  }

  const selectedColor = selectedPoint?.side === 'left' ? leftColor : rightColor
  const selectedLabel = selectedPoint?.side === 'left' ? leftLabel : rightLabel

  return (
    <div className="w-full">
      {/* Legend + selected value tooltip */}
      <div className="flex items-center justify-between mb-2 px-1">
        {/* Color-coded legend */}
        <div className="flex items-center gap-3">
          {sortedLeft.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span
                className="inline-block w-2.5 h-0.5 rounded-full"
                style={{ backgroundColor: leftColor }}
              />
              <span className="text-[10px] font-medium text-zinc-400">{leftLabel}</span>
            </div>
          )}
          {sortedRight.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span
                className="inline-block w-2.5 h-0.5 rounded-full"
                style={{ backgroundColor: rightColor }}
              />
              <span className="text-[10px] font-medium text-zinc-400">{rightLabel}</span>
            </div>
          )}
        </div>

        {/* Selected point tooltip */}
        {selectedPoint && (
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: selectedColor }}
            />
            <span className="text-xs font-medium" style={{ color: selectedColor }}>
              {formatValue(selectedPoint.point.value)} {unit}
            </span>
            <span className="text-[10px] text-zinc-500">
              {selectedLabel} · {formatTime(selectedPoint.point.timestamp)}
            </span>
          </div>
        )}
      </div>

      {/* SVG Chart */}
      <div ref={measureRef} className="w-full">
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
            {/* Left side gradient */}
            <linearGradient id={`${gradientId}-left`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={leftColor} stopOpacity="0.15" />
              <stop offset="100%" stopColor={leftColor} stopOpacity="0.02" />
            </linearGradient>
            {/* Right side gradient */}
            <linearGradient id={`${gradientId}-right`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={rightColor} stopOpacity="0.15" />
              <stop offset="100%" stopColor={rightColor} stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Zone backgrounds */}
          {zones.map(zone => {
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
                stroke="rgb(161 161 170)" /* zinc-400 */
                strokeWidth="1"
                strokeDasharray="4,4"
                opacity="0.4"
              />
              <text
                x={PADDING.left + 2}
                y={scaleY(average) - 4}
                fill="rgb(161 161 170)" /* zinc-400 */
                fontSize="8"
                opacity="0.6"
              >
                avg
              </text>
            </g>
          )}

          {/* Left side area fill */}
          {leftPaths.areaPath && (
            <path d={leftPaths.areaPath} fill={`url(#${gradientId}-left)`} />
          )}

          {/* Right side area fill */}
          {rightPaths.areaPath && (
            <path d={rightPaths.areaPath} fill={`url(#${gradientId}-right)`} />
          )}

          {/* Left side data line */}
          {leftPaths.linePath && (
            <path
              d={leftPaths.linePath}
              fill="none"
              stroke={leftColor}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {/* Right side data line */}
          {rightPaths.linePath && (
            <path
              d={rightPaths.linePath}
              fill="none"
              stroke={rightColor}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {/* Selected point indicator */}
          {selectedPoint && (
            <g>
              {/* Vertical guide line */}
              <line
                x1={scaleX(selectedPoint.point.timestamp.getTime())}
                y1={PADDING.top}
                x2={scaleX(selectedPoint.point.timestamp.getTime())}
                y2={PADDING.top + chartHeight}
                stroke="white"
                strokeWidth="1"
                opacity="0.2"
              />
              {/* Selected point circle with side color */}
              <circle
                cx={scaleX(selectedPoint.point.timestamp.getTime())}
                cy={scaleY(selectedPoint.point.value)}
                r="5"
                fill={selectedColor}
                opacity="0.3"
              />
              <circle
                cx={scaleX(selectedPoint.point.timestamp.getTime())}
                cy={scaleY(selectedPoint.point.value)}
                r="3"
                fill="white"
                stroke={selectedColor}
                strokeWidth="1.5"
              />
            </g>
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
    </div>
  )
}
