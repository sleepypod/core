'use client'

import { useMemo } from 'react'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
} from 'recharts'
import { SectionLabel } from '@/src/components/ds'
import { TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from '@/src/components/Sensors/chartTheme'

interface HumidityDataPoint {
  timestamp: Date | string
  humidity: number | null
}

interface HumidityChartProps {
  data: HumidityDataPoint[]
}

function formatTime(timestamp: string | Date): string {
  const d = new Date(timestamp)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** Humidity card body: current value, flat area chart, min/avg/max footer. */
export function HumidityChart({ data }: HumidityChartProps) {
  const chartData = useMemo(() => {
    const sorted = [...data].reverse()
    const mapped = sorted.map(d => ({
      time: new Date(d.timestamp).getTime(),
      humidity: d.humidity !== null ? Math.round(d.humidity * 10) / 10 : null,
    }))

    // Downsample
    const maxPoints = 120
    const step = Math.max(1, Math.floor(mapped.length / maxPoints))
    return step > 1
      ? mapped.filter((_, i) => i % step === 0 || i === mapped.length - 1)
      : mapped
  }, [data])

  const stats = useMemo(() => {
    const values = data.map(d => d.humidity).filter((v): v is number => v !== null)
    if (values.length === 0) return null
    return {
      // API order is newest-first
      latest: values[0],
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((a, b) => a + b, 0) / values.length,
    }
  }, [data])

  return (
    <>
      <SectionLabel right={stats && <span className="text-base text-fg">{`${Math.round(stats.latest)}%`}</span>}>
        Humidity
      </SectionLabel>

      {chartData.length === 0 || !stats
        ? (
            <div className="flex h-[130px] items-center justify-center text-[13px] text-fg-3">
              No humidity data available
            </div>
          )
        : (
            <div className="h-[130px] w-full">
              <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                <AreaChart data={chartData} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                  <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} hide />
                  <YAxis domain={[Math.floor(stats.min - 2), Math.ceil(stats.max + 2)]} hide />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    labelStyle={TOOLTIP_LABEL_STYLE}
                    labelFormatter={v => formatTime(new Date(v as number))}
                    formatter={value => [`${Number(value).toFixed(1)}%`, 'Humidity']}
                  />
                  <Area
                    type="monotone"
                    dataKey="humidity"
                    stroke="var(--chart-humidity)"
                    strokeWidth={1.5}
                    fill="var(--chart-humidity)"
                    fillOpacity={0.12}
                    dot={false}
                    activeDot={{ r: 3, fill: 'var(--chart-humidity)' }}
                    connectNulls
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

      <div className="grid grid-cols-3 border-t border-line pt-2.5 font-mono text-xs text-fg-2">
        <span>
          {'min '}
          <span className="text-fg">{stats ? Math.round(stats.min) : '--'}</span>
        </span>
        <span>
          {'avg '}
          <span className="text-fg">{stats ? Math.round(stats.avg) : '--'}</span>
        </span>
        <span>
          {'max '}
          <span className="text-fg">{stats ? Math.round(stats.max) : '--'}</span>
        </span>
      </div>
    </>
  )
}
