'use client'

import { useMemo } from 'react'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'

interface BedTempDataPoint {
  timestamp: Date | string
  leftCenterTemp: number | null
  rightCenterTemp: number | null
  ambientTemp: number | null
}

interface BedTempChartProps {
  data: BedTempDataPoint[]
  unit: 'F' | 'C'
  showAmbient?: boolean
  /** Which side to visually emphasize. 'both' gives equal prominence to both lines. */
  highlightSide?: 'left' | 'right' | 'both'
}

function formatTime(timestamp: string | Date): string {
  const d = new Date(timestamp)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatTooltipTime(timestamp: string | Date): string {
  const d = new Date(timestamp)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

interface ChartDataPoint {
  time: number
  timeLabel: string
  left: number | null
  right: number | null
  ambient: number | null
}

export function BedTempChart({ data, unit, showAmbient = false, highlightSide }: BedTempChartProps) {
  const chartData = useMemo(() => {
    // Data comes in desc order from API, reverse for chronological
    const sorted = [...data].reverse()
    return sorted.map(d => ({
      time: new Date(d.timestamp).getTime(),
      timeLabel: formatTime(d.timestamp),
      left: d.leftCenterTemp !== null ? Math.round(d.leftCenterTemp * 10) / 10 : null,
      right: d.rightCenterTemp !== null ? Math.round(d.rightCenterTemp * 10) / 10 : null,
      ambient: d.ambientTemp !== null ? Math.round(d.ambientTemp * 10) / 10 : null,
    })) as ChartDataPoint[]
  }, [data])

  if (chartData.length === 0) {
    return (
      <div className="flex h-[200px] items-center justify-center text-sm text-zinc-500">
        No temperature data available
      </div>
    )
  }

  // Compute Y-axis domain with padding
  const allTemps = chartData.flatMap((d) => {
    const temps: number[] = []
    if (d.left !== null) temps.push(d.left)
    if (d.right !== null) temps.push(d.right)
    if (showAmbient && d.ambient !== null) temps.push(d.ambient)
    return temps
  })

  const minTemp = Math.floor(Math.min(...allTemps) - 2)
  const maxTemp = Math.ceil(Math.max(...allTemps) + 2)

  // Downsample to ~120 points max for performance
  const maxPoints = 120
  const step = Math.max(1, Math.floor(chartData.length / maxPoints))
  const downsampled = step > 1
    ? chartData.filter((_, i) => i % step === 0 || i === chartData.length - 1)
    : chartData

  return (
    <div className="h-[200px] w-full">
      <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
        <LineChart data={downsampled} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" strokeOpacity={0.5} />
          <XAxis
            dataKey="time"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(v: number) => formatTime(new Date(v))}
            tick={{ fill: '#71717a', fontSize: 10 }}
            stroke="#333"
            tickCount={4}
          />
          <YAxis
            domain={[minTemp, maxTemp]}
            tick={{ fill: '#71717a', fontSize: 10 }}
            stroke="#333"
            tickFormatter={(v: number) => `${Math.round(v)}°`}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1a1a1a',
              border: '1px solid #333',
              borderRadius: 8,
              fontSize: 12,
              color: '#fff',
            }}
            labelFormatter={v => formatTooltipTime(new Date(v as number))}
            formatter={(value, name) => [
              `${Number(value).toFixed(1)}°${unit}`,
              String(name),
            ]}
          />
          <Legend
            iconType="circle"
            iconSize={6}
            wrapperStyle={{ fontSize: 10, color: '#a1a1aa' }}
            align="center"
          />
          <Line
            type="monotone"
            dataKey="left"
            name="Left"
            stroke="#5cb8e0"
            strokeWidth={highlightSide === 'both' ? 2 : highlightSide === 'left' ? 2 : highlightSide === 'right' ? 1 : 1.5}
            strokeOpacity={highlightSide === 'right' ? 0.3 : 1}
            dot={false}
            activeDot={{ r: 3, fill: '#5cb8e0' }}
            connectNulls
          />
          <Line
            type="monotone"
            dataKey="right"
            name="Right"
            stroke="#40e0d0"
            strokeWidth={highlightSide === 'both' ? 2 : highlightSide === 'right' ? 2 : highlightSide === 'left' ? 1 : 1.5}
            strokeOpacity={highlightSide === 'left' ? 0.3 : 1}
            dot={false}
            activeDot={{ r: 3, fill: '#40e0d0' }}
            connectNulls
          />
          {showAmbient && (
            <Line
              type="monotone"
              dataKey="ambient"
              name="Ambient"
              stroke="#d4a84a"
              strokeWidth={1}
              strokeDasharray="4 2"
              dot={false}
              activeDot={{ r: 3, fill: '#d4a84a' }}
              connectNulls
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
