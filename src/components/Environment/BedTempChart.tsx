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
} from 'recharts'
import { AXIS_TICK, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from '@/src/components/Sensors/chartTheme'

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
      <div className="flex h-[170px] items-center justify-center text-[13px] text-fg-3">
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
    <div className="h-[170px] w-full">
      <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
        <LineChart data={downsampled} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border-grid)" />
          <XAxis
            dataKey="time"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(v: number) => formatTime(new Date(v))}
            tick={{ ...AXIS_TICK, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickCount={6}
          />
          <YAxis
            domain={[minTemp, maxTemp]}
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            tickCount={4}
            tickFormatter={(v: number) => `${Math.round(v)}°`}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
            labelFormatter={v => formatTooltipTime(new Date(v as number))}
            formatter={(value, name) => [
              `${Number(value).toFixed(1)}°${unit}`,
              String(name),
            ]}
          />
          {showAmbient && (
            <Line
              type="monotone"
              dataKey="ambient"
              name="Ambient"
              stroke="var(--text-3)"
              strokeWidth={1.5}
              strokeDasharray="4 4"
              dot={false}
              activeDot={{ r: 3, fill: 'var(--text-3)' }}
              connectNulls
            />
          )}
          <Line
            type="monotone"
            dataKey="left"
            name="Left"
            stroke="var(--accent-cool)"
            strokeWidth={highlightSide === 'both' ? 2 : highlightSide === 'left' ? 2 : highlightSide === 'right' ? 1 : 1.5}
            strokeOpacity={highlightSide === 'right' ? 0.3 : 1}
            dot={false}
            activeDot={{ r: 3, fill: 'var(--accent-cool)' }}
            connectNulls
          />
          <Line
            type="monotone"
            dataKey="right"
            name="Right"
            stroke="var(--accent-warm)"
            strokeWidth={highlightSide === 'both' ? 2 : highlightSide === 'right' ? 2 : highlightSide === 'left' ? 1 : 1.5}
            strokeOpacity={highlightSide === 'left' ? 0.3 : 1}
            dot={false}
            activeDot={{ r: 3, fill: 'var(--accent-warm)' }}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
