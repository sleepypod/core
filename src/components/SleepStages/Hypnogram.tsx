'use client'

import { useMemo, useState, useCallback, useRef } from 'react'
import type { SleepStage } from '@/src/lib/sleep-stages'
import { STAGE_COLORS, STAGE_ORDER } from '@/src/lib/sleep-stages'

interface HypnogramBlock {
  start: number
  end: number
  stage: SleepStage
}

interface HypnogramEpoch {
  start: number
  duration: number
  stage: SleepStage
  heartRate: number | null
  hrv: number | null
  breathingRate: number | null
}

interface HypnogramProps {
  blocks: HypnogramBlock[]
  epochs: HypnogramEpoch[]
  startTime: number // unix ms
  endTime: number // unix ms
}

const STAGE_LABELS: SleepStage[] = ['wake', 'rem', 'light', 'deep']
const STAGE_DISPLAY: Record<SleepStage, string> = {
  wake: 'Wake',
  rem: 'REM',
  light: 'Light',
  deep: 'Deep',
}

const CHART_HEIGHT = 160
const CHART_PADDING_LEFT = 52
const CHART_PADDING_RIGHT = 12
const CHART_PADDING_TOP = 8
const CHART_PADDING_BOTTOM = 28
const BAND_HEIGHT = (CHART_HEIGHT - CHART_PADDING_TOP - CHART_PADDING_BOTTOM) / 4
const SVG_HEIGHT = CHART_HEIGHT

function formatTime(ms: number): string {
  const d = new Date(ms)
  const h = d.getHours()
  const m = d.getMinutes()
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return m === 0 ? `${h12}${ampm}` : `${h12}:${m.toString().padStart(2, '0')}${ampm}`
}

/**
 * SVG-based hypnogram chart showing sleep stages over time.
 *
 * Y-axis: 4 discrete stages (Deep at bottom, Wake at top)
 * X-axis: Time with hour labels
 * Interactive: tap to select epoch and view vitals detail
 */
export function Hypnogram({ blocks, epochs, startTime, endTime }: HypnogramProps) {
  const [selectedEpoch, setSelectedEpoch] = useState<HypnogramEpoch | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const totalDuration = endTime - startTime
  const chartWidth = 360 // will be responsive via viewBox
  const plotWidth = chartWidth - CHART_PADDING_LEFT - CHART_PADDING_RIGHT

  // Map time to x position
  const timeToX = useCallback(
    (t: number) => {
      if (totalDuration <= 0) return CHART_PADDING_LEFT
      return CHART_PADDING_LEFT + ((t - startTime) / totalDuration) * plotWidth
    },
    [startTime, totalDuration, plotWidth],
  )

  // Map stage to y band center
  const stageToY = (stage: SleepStage) => {
    // STAGE_LABELS order: wake(0), rem(1), light(2), deep(3) — top to bottom
    const idx = STAGE_LABELS.indexOf(stage)
    return CHART_PADDING_TOP + idx * BAND_HEIGHT + BAND_HEIGHT / 2
  }

  // Generate time axis ticks (roughly every hour)
  const timeTicks = useMemo(() => {
    const ticks: number[] = []
    // Start from next whole hour after startTime
    const startHour = new Date(startTime)
    startHour.setMinutes(0, 0, 0)
    let tick = startHour.getTime() + 3600_000
    while (tick < endTime) {
      ticks.push(tick)
      tick += 3600_000
    }
    return ticks
  }, [startTime, endTime])

  // Handle tap to find nearest epoch
  const handleClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!svgRef.current || epochs.length === 0) return
      const rect = svgRef.current.getBoundingClientRect()
      const clickX = ((e.clientX - rect.left) / rect.width) * chartWidth
      const clickTime = startTime + ((clickX - CHART_PADDING_LEFT) / plotWidth) * totalDuration

      // Find nearest epoch
      let nearest = epochs[0]
      let minDist = Math.abs(epochs[0].start + epochs[0].duration / 2 - clickTime)
      for (const ep of epochs) {
        const mid = ep.start + ep.duration / 2
        const dist = Math.abs(mid - clickTime)
        if (dist < minDist) {
          minDist = dist
          nearest = ep
        }
      }
      setSelectedEpoch(prev => (prev?.start === nearest.start ? null : nearest))
    },
    [epochs, startTime, totalDuration, plotWidth, chartWidth],
  )

  // Early return AFTER all hooks to satisfy Rules of Hooks
  if (totalDuration <= 0 || blocks.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-zinc-500 text-sm">
        No sleep stage data available
      </div>
    )
  }

  return (
    <div className="w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${chartWidth} ${SVG_HEIGHT}`}
        className="w-full touch-none"
        onClick={handleClick}
      >
        {/* Y-axis labels */}
        {STAGE_LABELS.map(stage => (
          <text
            key={stage}
            x={CHART_PADDING_LEFT - 8}
            y={stageToY(stage)}
            textAnchor="end"
            dominantBaseline="central"
            className="fill-zinc-500"
            fontSize="10"
          >
            {STAGE_DISPLAY[stage]}
          </text>
        ))}

        {/* Horizontal grid lines */}
        {STAGE_LABELS.map(stage => (
          <line
            key={`grid-${stage}`}
            x1={CHART_PADDING_LEFT}
            y1={stageToY(stage)}
            x2={chartWidth - CHART_PADDING_RIGHT}
            y2={stageToY(stage)}
            stroke="#27272a"
            strokeWidth="0.5"
          />
        ))}

        {/* Stage blocks as rectangles */}
        {blocks.map((block, i) => {
          const x = timeToX(Math.max(block.start, startTime))
          const xEnd = timeToX(Math.min(block.end, endTime))
          const y = stageToY(block.stage) - BAND_HEIGHT / 2 + 2
          const width = Math.max(xEnd - x, 1)
          const height = BAND_HEIGHT - 4

          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={width}
              height={height}
              rx={3}
              fill={STAGE_COLORS[block.stage]}
              opacity={0.85}
            />
          )
        })}

        {/* Time axis ticks */}
        {timeTicks.map(tick => (
          <g key={tick}>
            <line
              x1={timeToX(tick)}
              y1={CHART_HEIGHT - CHART_PADDING_BOTTOM}
              x2={timeToX(tick)}
              y2={CHART_HEIGHT - CHART_PADDING_BOTTOM + 4}
              stroke="#52525b"
              strokeWidth="0.5"
            />
            <text
              x={timeToX(tick)}
              y={CHART_HEIGHT - CHART_PADDING_BOTTOM + 16}
              textAnchor="middle"
              className="fill-zinc-500"
              fontSize="9"
            >
              {formatTime(tick)}
            </text>
          </g>
        ))}

        {/* Selection indicator */}
        {selectedEpoch && (
          <>
            <line
              x1={timeToX(selectedEpoch.start + selectedEpoch.duration / 2)}
              y1={CHART_PADDING_TOP}
              x2={timeToX(selectedEpoch.start + selectedEpoch.duration / 2)}
              y2={CHART_HEIGHT - CHART_PADDING_BOTTOM}
              stroke="white"
              strokeWidth="1"
              strokeDasharray="2,2"
              opacity={0.6}
            />
            <circle
              cx={timeToX(selectedEpoch.start + selectedEpoch.duration / 2)}
              cy={stageToY(selectedEpoch.stage)}
              r={4}
              fill="white"
              stroke={STAGE_COLORS[selectedEpoch.stage]}
              strokeWidth="2"
            />
          </>
        )}
      </svg>

      {/* Selected epoch detail */}
      {selectedEpoch && (
        <div className="mt-2 flex items-center justify-between rounded-lg bg-zinc-900 px-3 py-2 text-xs">
          <span className="text-zinc-400">
            {formatTime(selectedEpoch.start)}
          </span>
          <span
            className="font-medium"
            style={{ color: STAGE_COLORS[selectedEpoch.stage] }}
          >
            {STAGE_DISPLAY[selectedEpoch.stage]}
          </span>
          {selectedEpoch.heartRate !== null && (
            <span className="text-zinc-400">
              {Math.round(selectedEpoch.heartRate)} bpm
            </span>
          )}
          {selectedEpoch.hrv !== null && (
            <span className="text-zinc-400">
              HRV {Math.round(selectedEpoch.hrv)}ms
            </span>
          )}
          {selectedEpoch.breathingRate !== null && (
            <span className="text-zinc-400">
              {Math.round(selectedEpoch.breathingRate)} br/m
            </span>
          )}
        </div>
      )}
    </div>
  )
}
