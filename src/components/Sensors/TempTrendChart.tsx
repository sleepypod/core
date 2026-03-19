'use client'

import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { useOnSensorFrame, type SensorFrame, type BedTempFrame, type BedTemp2Frame } from '@/src/hooks/useSensorStream'
import { trpc } from '@/src/utils/trpc'
import { TrendingUp } from 'lucide-react'

const MAX_HISTORY = 120
const LEFT_COLOR = '#4a9eff'
const RIGHT_COLOR = '#40e0d0'
const GRID_COLOR = '#27272a'

interface TempPoint {
  time: number // epoch ms
  leftF: number | null
  rightF: number | null
}

function celsiusToF(c: number | undefined): number | null {
  if (c === undefined || c === null || c < -200) return null
  return (c * 9) / 5 + 32
}

/**
 * Temperature trend chart showing historical bed temperature readings.
 * Draws a simple SVG line chart of left vs right temps over time.
 *
 * Pre-populates from tRPC environment.getBedTemp historical data,
 * then appends live WebSocket frames as they arrive.
 * Matches iOS BedSensorScreen tempTrendCard.
 */
export function TempTrendChart() {
  const [history, setHistory] = useState<TempPoint[]>([])
  const seededRef = useRef(false)

  // tRPC: fetch last hour of bed temp history to pre-populate the chart
  const oneHourAgo = useMemo(() => new Date(Date.now() - 60 * 60 * 1000), [])
  const now = useMemo(() => new Date(), [])

  const historicalBedTemp = trpc.environment.getBedTemp.useQuery(
    {
      startDate: oneHourAgo,
      endDate: now,
      limit: MAX_HISTORY,
      unit: 'F',
    },
    {
      staleTime: 60_000,
      // Only fetch once to seed the chart
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      refetchOnReconnect: false,
    },
  )

  // Seed the chart with historical data from tRPC (once)
  useEffect(() => {
    if (seededRef.current || !historicalBedTemp.data) return
    const data = historicalBedTemp.data as Array<{
      timestamp: Date | string
      leftCenterTemp: number | null
      leftInnerTemp: number | null
      rightCenterTemp: number | null
      rightInnerTemp: number | null
    }>

    if (data.length === 0) return

    // Data comes in descending order from tRPC, reverse for chronological
    const points: TempPoint[] = [...data].reverse().map(row => ({
      time: new Date(row.timestamp).getTime(),
      leftF: row.leftCenterTemp ?? row.leftInnerTemp ?? null,
      rightF: row.rightCenterTemp ?? row.rightInnerTemp ?? null,
    })).filter(p => p.leftF !== null || p.rightF !== null)

    if (points.length > 0) {
      setHistory(points.slice(-MAX_HISTORY))
      seededRef.current = true
    }
  }, [historicalBedTemp.data])

  // Append live WebSocket frames
  useOnSensorFrame(useCallback((frame: SensorFrame) => {
    if (frame.type !== 'bedTemp' && frame.type !== 'bedTemp2') return
    const f = frame as BedTempFrame | BedTemp2Frame

    // Average left and right center temps for trend
    const leftC = f.leftCenterTemp ?? f.leftInnerTemp
    const rightC = f.rightCenterTemp ?? f.rightInnerTemp
    const leftF = celsiusToF(leftC)
    const rightF = celsiusToF(rightC)

    if (leftF === null && rightF === null) return

    seededRef.current = true // Mark as seeded even from live data

    setHistory(prev => {
      const next = [...prev, { time: Date.now(), leftF, rightF }]
      return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next
    })
  }, []))

  if (history.length < 2) {
    return (
      <div className="space-y-2.5">
        <div className="flex items-center gap-1.5">
          <TrendingUp size={10} className="text-amber-400" />
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Temperature Trend
          </h3>
        </div>
        <div className="flex h-24 items-center justify-center rounded-xl bg-zinc-800/50">
          <span className="text-xs text-zinc-600">
            {historicalBedTemp.isLoading ? 'Loading temperature history...' : 'Collecting temperature data...'}
          </span>
        </div>
      </div>
    )
  }

  // Compute bounds
  const allTemps = history.flatMap(p => [p.leftF, p.rightF].filter((v): v is number => v !== null))
  const minTemp = Math.min(...allTemps) - 1
  const maxTemp = Math.max(...allTemps) + 1
  const tempRange = maxTemp - minTemp || 1

  const chartW = 300
  const chartH = 100
  const pad = { top: 4, right: 4, bottom: 16, left: 30 }
  const plotW = chartW - pad.left - pad.right
  const plotH = chartH - pad.top - pad.bottom

  function toX(i: number): number {
    return pad.left + (i / (history.length - 1)) * plotW
  }
  function toY(temp: number): number {
    return pad.top + plotH - ((temp - minTemp) / tempRange) * plotH
  }

  function makePath(key: 'leftF' | 'rightF'): string {
    const points: string[] = []
    for (let i = 0; i < history.length; i++) {
      const v = history[i][key]
      if (v === null) continue
      const x = toX(i).toFixed(1)
      const y = toY(v).toFixed(1)
      points.push(points.length === 0 ? `M${x},${y}` : `L${x},${y}`)
    }
    return points.join(' ')
  }

  // Y-axis labels (3 ticks)
  const yTicks = [minTemp, (minTemp + maxTemp) / 2, maxTemp]
  // X-axis time labels (4 ticks)
  const xIndices = [0, Math.floor(history.length / 3), Math.floor((2 * history.length) / 3), history.length - 1]

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <TrendingUp size={10} className="text-amber-400" />
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Temperature Trend
          </h3>
        </div>
        <span className="text-[8px] text-zinc-600">
          {history.length} points
        </span>
      </div>

      <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full" preserveAspectRatio="xMidYMid meet">
        {/* Grid lines */}
        {yTicks.map((t, i) => (
          <line
            key={`y${i}`}
            x1={pad.left}
            x2={chartW - pad.right}
            y1={toY(t)}
            y2={toY(t)}
            stroke={GRID_COLOR}
            strokeWidth={0.5}
          />
        ))}

        {/* Y-axis labels */}
        {yTicks.map((t, i) => (
          <text
            key={`yl${i}`}
            x={pad.left - 3}
            y={toY(t)}
            textAnchor="end"
            dominantBaseline="middle"
            fill="#52525b"
            fontSize={7}
          >
            {t.toFixed(0)}°
          </text>
        ))}

        {/* X-axis time labels */}
        {xIndices.map((idx, i) => {
          const t = new Date(history[idx].time)
          const label = `${t.getHours().toString().padStart(2, '0')}:${t.getMinutes().toString().padStart(2, '0')}`
          return (
            <text
              key={`xl${i}`}
              x={toX(idx)}
              y={chartH - 2}
              textAnchor="middle"
              fill="#52525b"
              fontSize={7}
            >
              {label}
            </text>
          )
        })}

        {/* Left line */}
        <path d={makePath('leftF')} fill="none" stroke={LEFT_COLOR} strokeWidth={1.5} strokeLinejoin="round" />
        {/* Right line */}
        <path d={makePath('rightF')} fill="none" stroke={RIGHT_COLOR} strokeWidth={1.5} strokeLinejoin="round" />
      </svg>

      {/* Legend */}
      <div className="flex items-center justify-center gap-3">
        <div className="flex items-center gap-1">
          <span className="inline-block h-1 w-3 rounded-full" style={{ backgroundColor: LEFT_COLOR }} />
          <span className="text-[8px] text-zinc-600">Left</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="inline-block h-1 w-3 rounded-full" style={{ backgroundColor: RIGHT_COLOR }} />
          <span className="text-[8px] text-zinc-600">Right</span>
        </div>
      </div>
    </div>
  )
}
