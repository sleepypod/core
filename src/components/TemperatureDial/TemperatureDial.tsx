'use client'

import { useCallback, useRef, useState } from 'react'
import { colorForDelta, glowColorForDelta, TEMP, tempFToOffset, offsetDisplay, theme } from '@/src/lib/tempColors'
import { formatTemp } from '@/src/lib/tempUtils'

// Dial geometry — matches iOS TemperatureDialView
const DIAL_SIZE = 280
const RING_WIDTH = 10
const THUMB_SIZE = 22
const START_ANGLE = 135 // degrees
const TOTAL_SWEEP = 270 // degrees
const RADIUS = DIAL_SIZE / 2

// SVG viewBox with padding for thumb overflow
const PADDING = THUMB_SIZE
const VIEW_SIZE = DIAL_SIZE + PADDING * 2
const CENTER = VIEW_SIZE / 2

interface TemperatureDialProps {
  /** Current bed temperature in °F */
  currentTempF: number
  /** Target temperature in °F */
  targetTempF: number
  /** Whether the side is powered on */
  isOn: boolean
  /** Called when user drags to a new target temperature */
  onTemperatureChange: (tempF: number) => void
  /** Called when drag ends (for committing the final value) */
  onTemperatureCommit?: (tempF: number) => void
}

/** Convert degrees to radians. */
function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/** Calculate normalized progress (0–1) for a temperature within the dial range. */
function tempToProgress(tempF: number): number {
  const clamped = Math.max(TEMP.MIN_F, Math.min(TEMP.MAX_F, tempF))
  return (clamped - TEMP.MIN_F) / (TEMP.MAX_F - TEMP.MIN_F)
}

/** Calculate (x, y) position on the arc for a given progress. */
function progressToPoint(progress: number, r: number = RADIUS): { x: number; y: number } {
  const angle = START_ANGLE + progress * TOTAL_SWEEP
  const rad = toRad(angle)
  return {
    x: CENTER + Math.cos(rad) * r,
    y: CENTER + Math.sin(rad) * r,
  }
}

/**
 * Generate an SVG arc path from startProgress to endProgress.
 * Uses the arc command to draw along the circle.
 */
function arcPath(startProgress: number, endProgress: number, r: number = RADIUS): string {
  const start = progressToPoint(startProgress, r)
  const end = progressToPoint(endProgress, r)
  const sweepDeg = (endProgress - startProgress) * TOTAL_SWEEP
  const largeArc = sweepDeg > 180 ? 1 : 0

  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`
}

export function TemperatureDial({
  currentTempF,
  targetTempF,
  isOn,
  onTemperatureChange,
  onTemperatureCommit,
}: TemperatureDialProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const lastTempRef = useRef(targetTempF)

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isOn) return
    let delta = 0
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') delta = 1
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') delta = -1
    if (delta === 0) return
    e.preventDefault()
    const newTemp = Math.max(TEMP.MIN_F, Math.min(TEMP.MAX_F, targetTempF + delta))
    onTemperatureChange(newTemp)
    onTemperatureCommit?.(newTemp)
  }, [isOn, targetTempF, onTemperatureChange, onTemperatureCommit])

  const targetProgress = tempToProgress(targetTempF)
  const currentProgress = tempToProgress(currentTempF)
  const delta = targetTempF - currentTempF

  const ringColor = isOn ? colorForDelta(delta) : '#333333'
  const tempColor = isOn ? colorForDelta(delta) : theme.textMuted
  const glow = isOn ? glowColorForDelta(delta) : { color: '#888', opacity: 0.2 }

  // Direction label
  const direction = isOn && targetTempF !== currentTempF
    ? targetTempF > currentTempF
      ? { text: 'WARMING', color: theme.warming }
      : { text: 'COOLING', color: theme.cooling }
    : null

  const offset = tempFToOffset(targetTempF)

  // --- Drag handling ---

  const angleToTemp = useCallback((clientX: number, clientY: number): number | null => {
    const svg = svgRef.current
    if (!svg) return null

    const rect = svg.getBoundingClientRect()
    const scaleX = VIEW_SIZE / rect.width
    const scaleY = VIEW_SIZE / rect.height
    const svgX = (clientX - rect.left) * scaleX
    const svgY = (clientY - rect.top) * scaleY

    const dx = svgX - CENTER
    const dy = svgY - CENTER

    // atan2 gives angle from positive x-axis
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI
    if (angle < 0) angle += 360

    // Normalize angle relative to startAngle
    let normalizedAngle = angle
    if (normalizedAngle < START_ANGLE) normalizedAngle += 360

    const progress = (normalizedAngle - START_ANGLE) / TOTAL_SWEEP

    // Reject if outside the arc (in the gap)
    if (progress < 0 || progress > 1) return null

    const range = TEMP.MAX_F - TEMP.MIN_F
    const newTemp = TEMP.MIN_F + Math.round(progress * range)
    return Math.max(TEMP.MIN_F, Math.min(TEMP.MAX_F, newTemp))
  }, [])

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!isOn) return
      e.preventDefault()
      ;(e.target as Element).setPointerCapture(e.pointerId)
      setIsDragging(true)

      const temp = angleToTemp(e.clientX, e.clientY)
      if (temp !== null) {
        lastTempRef.current = temp
        onTemperatureChange(temp)
      }
    },
    [isOn, angleToTemp, onTemperatureChange]
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging) return
      e.preventDefault()

      const temp = angleToTemp(e.clientX, e.clientY)
      if (temp !== null && temp !== lastTempRef.current) {
        lastTempRef.current = temp
        onTemperatureChange(temp)
      }
    },
    [isDragging, angleToTemp, onTemperatureChange]
  )

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging) return
      ;(e.target as Element).releasePointerCapture(e.pointerId)
      setIsDragging(false)
      onTemperatureCommit?.(lastTempRef.current)
    },
    [isDragging, onTemperatureCommit]
  )

  // --- Arc paths ---
  const bgArcPath = arcPath(0, 1)

  // Journey arc between current and target
  const fromProgress = Math.min(currentProgress, targetProgress)
  const toProgress = Math.max(currentProgress, targetProgress)
  const journeyPath = fromProgress !== toProgress ? arcPath(fromProgress, toProgress) : null

  // Target arc from start to target
  const targetArcPath = arcPath(0, targetProgress)

  // Thumb position
  const thumbPos = progressToPoint(targetProgress)

  // Current temp marker
  const currentMarkerPos = progressToPoint(currentProgress)
  const markerAngle = START_ANGLE + currentProgress * TOTAL_SWEEP
  const nowLabelPos = progressToPoint(currentProgress, RADIUS + 20)

  return (
    <div className="flex items-center justify-center py-2 sm:py-4" style={{ touchAction: 'none' }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_SIZE} ${VIEW_SIZE}`}
        className="aspect-square w-full max-w-[302px] select-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
        role="slider"
        aria-label="Temperature dial"
        aria-valuemin={TEMP.MIN_F}
        aria-valuemax={TEMP.MAX_F}
        aria-valuenow={targetTempF}
        aria-valuetext={`${targetTempF}°F`}
        tabIndex={isOn ? 0 : -1}
      >
        {/* Background track (full arc) */}
        <path
          d={bgArcPath}
          fill="none"
          stroke="#222222"
          strokeWidth={RING_WIDTH}
          strokeLinecap="round"
        />

        {/* Colored journey arc between current and target */}
        {isOn && journeyPath && (
          <path
            d={journeyPath}
            fill="none"
            stroke={ringColor}
            strokeOpacity={0.4}
            strokeWidth={RING_WIDTH + 4}
            strokeLinecap="round"
          />
        )}

        {/* Target position arc (from start to target) */}
        {isOn && (
          <path
            d={targetArcPath}
            fill="none"
            stroke={ringColor}
            strokeWidth={RING_WIDTH}
            strokeLinecap="round"
          />
        )}

        {/* Current temperature "NOW" marker */}
        {isOn && (
          <g>
            <line
              x1={currentMarkerPos.x}
              y1={currentMarkerPos.y - 6}
              x2={currentMarkerPos.x}
              y2={currentMarkerPos.y + 6}
              stroke="white"
              strokeOpacity={0.6}
              strokeWidth={2}
              strokeLinecap="round"
              transform={`rotate(${markerAngle + 90}, ${currentMarkerPos.x}, ${currentMarkerPos.y})`}
            />
            <text
              x={nowLabelPos.x}
              y={nowLabelPos.y}
              textAnchor="middle"
              dominantBaseline="central"
              fill="white"
              fillOpacity={0.5}
              fontSize={7}
              fontWeight="bold"
            >
              NOW
            </text>
          </g>
        )}

        {/* Draggable thumb */}
        {isOn && (
          <circle
            cx={thumbPos.x}
            cy={thumbPos.y}
            r={THUMB_SIZE / 2}
            fill="white"
            style={{
              filter: `drop-shadow(0 0 6px ${glow.color}) drop-shadow(0 1px 3px rgba(0,0,0,0.3))`,
              cursor: isDragging ? 'grabbing' : 'grab',
            }}
          />
        )}

        {/* Center content */}
        <foreignObject
          x={CENTER - 100}
          y={CENTER - 60}
          width={200}
          height={120}
        >
          <div
            className="flex h-full flex-col items-center justify-center"
            style={{ pointerEvents: 'none' }}
          >
            {isOn ? (
              <>
                {/* Direction label */}
                {direction && (
                  <div className="mb-1 flex items-center gap-1.5">
                    <span style={{ color: direction.color, fontSize: 10, fontWeight: 700 }}>
                      {direction.text === 'WARMING' ? '🔥' : '❄️'}
                    </span>
                    <span
                      className="tracking-widest"
                      style={{
                        color: direction.color,
                        fontSize: 11,
                        fontWeight: 600,
                        opacity: 0.9,
                      }}
                    >
                      {direction.text}
                    </span>
                  </div>
                )}

                {/* Target temperature (hero) */}
                <span
                  className="font-light tabular-nums"
                  style={{
                    color: tempColor,
                    fontSize: 52,
                    lineHeight: 1,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {formatTemp(targetTempF)}
                </span>

                {/* Offset + current temp */}
                <div className="mt-1.5 flex items-center gap-2">
                  <span
                    className="font-semibold tabular-nums"
                    style={{
                      color: tempColor,
                      fontSize: 15,
                      opacity: 0.7,
                    }}
                  >
                    {offsetDisplay(offset)}
                  </span>
                  <span style={{ color: theme.textMuted, fontSize: 13 }}>·</span>
                  <span style={{ color: theme.textMuted, fontSize: 13 }}>
                    Now {formatTemp(currentTempF)}
                  </span>
                </div>
              </>
            ) : (
              <span
                className="font-light"
                style={{ color: theme.textMuted, fontSize: 48 }}
              >
                OFF
              </span>
            )}
          </div>
        </foreignObject>
      </svg>
    </div>
  )
}
