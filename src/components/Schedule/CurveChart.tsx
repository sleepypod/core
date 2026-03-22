'use client'

import { useMemo } from 'react'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts'
import type { CurvePoint } from '@/src/lib/sleepCurve/types'
import { colorForTempOffset } from '@/src/lib/sleepCurve/tempColor'
import { phaseLabels } from '@/src/lib/sleepCurve/types'
import { curvePointToDisplayTime } from '@/src/lib/sleepCurve/generate'

const BASE_TEMP_F = 80

interface CurveChartProps {
  points: CurvePoint[]
  bedtimeMinutes: number
  minTempF: number
  maxTempF: number
}

interface ChartDataPoint {
  minutesFromBedtime: number
  tempF: number
  tempOffset: number
  phase: string
  displayTime: string
}

/** Custom tooltip for the temperature curve chart */
function CurveTooltip({ active, payload }: { active?: boolean, payload?: Array<{ payload: ChartDataPoint }> }) {
  if (!active || !payload?.[0]) return null
  const data = payload[0].payload
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs shadow-lg">
      <div className="font-medium text-white">{data.displayTime}</div>
      <div className="mt-1 flex items-center gap-2">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: colorForTempOffset(data.tempOffset) }}
        />
        <span className="text-zinc-300">
          {data.tempF}
          °F
        </span>
        <span className="text-zinc-500">·</span>
        <span className="text-zinc-400">{data.phase}</span>
      </div>
    </div>
  )
}

export function CurveChart({ points, bedtimeMinutes, minTempF, maxTempF }: CurveChartProps) {
  const chartData = useMemo<ChartDataPoint[]>(() => {
    return points.map(p => ({
      minutesFromBedtime: p.minutesFromBedtime,
      tempF: BASE_TEMP_F + p.tempOffset,
      tempOffset: p.tempOffset,
      phase: phaseLabels[p.phase],
      displayTime: curvePointToDisplayTime(p.minutesFromBedtime, bedtimeMinutes),
    }))
  }, [points, bedtimeMinutes])

  // Y-axis domain: pad 4°F around the min/max
  const yMin = Math.min(minTempF, ...chartData.map(d => d.tempF)) - 4
  const yMax = Math.max(maxTempF, ...chartData.map(d => d.tempF)) + 4

  // X-axis tick formatter: show actual time
  const formatXTick = (minutesFromBedtime: number) => {
    return curvePointToDisplayTime(minutesFromBedtime, bedtimeMinutes)
  }

  // Generate gradient stops based on curve data
  const gradientId = 'tempCurveGradient'
  const gradientStops = useMemo(() => {
    if (chartData.length < 2) return []
    const minX = chartData[0].minutesFromBedtime
    const maxX = chartData[chartData.length - 1].minutesFromBedtime
    const range = maxX - minX || 1
    return chartData.map(d => ({
      offset: `${((d.minutesFromBedtime - minX) / range) * 100}%`,
      color: colorForTempOffset(d.tempOffset),
    }))
  }, [chartData])

  // X-axis ticks: every 2 hours from first to last point
  const xTicks = useMemo(() => {
    if (chartData.length < 2) return []
    const first = chartData[0].minutesFromBedtime
    const last = chartData[chartData.length - 1].minutesFromBedtime
    const ticks: number[] = []
    // Start at bedtime (0) and step by 120 min
    const start = Math.ceil(first / 120) * 120
    for (let t = start; t <= last; t += 120) {
      ticks.push(t)
    }
    return ticks
  }, [chartData])

  return (
    <div className="w-full" style={{ height: 220 }}>
      <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
        <AreaChart
          data={chartData}
          margin={{ top: 8, right: 8, bottom: 0, left: -16 }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
              {gradientStops.map((stop, i) => (
                <stop key={i} offset={stop.offset} stopColor={stop.color} stopOpacity={0.6} />
              ))}
            </linearGradient>
            <linearGradient id={`${gradientId}Line`} x1="0" y1="0" x2="1" y2="0">
              {gradientStops.map((stop, i) => (
                <stop key={i} offset={stop.offset} stopColor={stop.color} stopOpacity={1} />
              ))}
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
          <XAxis
            dataKey="minutesFromBedtime"
            type="number"
            domain={['dataMin', 'dataMax']}
            ticks={xTicks}
            tickFormatter={formatXTick}
            tick={{ fill: '#71717a', fontSize: 10 }}
            axisLine={{ stroke: '#3f3f46' }}
            tickLine={false}
          />
          <YAxis
            domain={[yMin, yMax]}
            tick={{ fill: '#71717a', fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `${v}°`}
          />
          <Tooltip
            content={<CurveTooltip />}
            cursor={{ stroke: '#52525b', strokeDasharray: '3 3' }}
          />
          {/* Base temperature reference line */}
          <ReferenceLine
            y={BASE_TEMP_F}
            stroke="#52525b"
            strokeDasharray="4 4"
            label={{ value: '80°F', position: 'right', fill: '#71717a', fontSize: 9 }}
          />
          {/* Min temp reference */}
          <ReferenceLine y={minTempF} stroke="#3b82f6" strokeDasharray="2 2" strokeOpacity={0.4} />
          {/* Max temp reference */}
          <ReferenceLine y={maxTempF} stroke="#f97316" strokeDasharray="2 2" strokeOpacity={0.4} />
          {/* Bedtime marker */}
          <ReferenceLine
            x={0}
            stroke="#a855f7"
            strokeDasharray="4 4"
            strokeOpacity={0.6}
          />
          <Area
            type="monotone"
            dataKey="tempF"
            stroke={`url(#${gradientId}Line)`}
            strokeWidth={2.5}
            fill={`url(#${gradientId})`}
            fillOpacity={0.15}
            dot={false}
            activeDot={{ r: 4, fill: '#fff', strokeWidth: 2, stroke: '#3b82f6' }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
