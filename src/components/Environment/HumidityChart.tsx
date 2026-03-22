'use client'

import { useId, useMemo } from 'react'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts'

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

export function HumidityChart({ data }: HumidityChartProps) {
  const gradientId = useId()
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

  if (chartData.length === 0) {
    return (
      <div className="flex h-[140px] items-center justify-center text-sm text-zinc-500">
        No humidity data available
      </div>
    )
  }

  return (
    <div className="h-[140px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#4a90d9" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#4a90d9" stopOpacity={0.02} />
            </linearGradient>
          </defs>
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
            domain={[0, 100]}
            tick={{ fill: '#71717a', fontSize: 10 }}
            stroke="#333"
            tickFormatter={(v: number) => `${v}%`}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1a1a1a',
              border: '1px solid #333',
              borderRadius: 8,
              fontSize: 12,
              color: '#fff',
            }}
            labelFormatter={(v) => formatTime(new Date(v as number))}
            formatter={(value) => [`${Number(value).toFixed(1)}%`, 'Humidity']}
          />
          <Area
            type="monotone"
            dataKey="humidity"
            stroke="#4a90d9"
            strokeWidth={1.5}
            fill={`url(#${gradientId})`}
            dot={false}
            activeDot={{ r: 3, fill: '#4a90d9' }}
            connectNulls
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
