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

export interface VitalSample {
  timestamp: Date | string
  heartRate: number | null
  hrv: number | null
  breathingRate: number | null
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

/**
 * Week-long vitals trend for the Biometrics page. HR and HRV share the left
 * axis (similar magnitude); breathing rate gets its own right axis so it isn't
 * crushed flat against the bottom. Downsampled to keep the line responsive.
 */
export function BiometricsTrendChart({ rows }: { rows: VitalSample[] }) {
  const data = useMemo(() => {
    const points = rows
      .map(r => ({
        t: new Date(r.timestamp).getTime(),
        hr: r.heartRate,
        hrv: r.hrv,
        br: r.breathingRate,
      }))
      .sort((a, b) => a.t - b.t)
    const maxPoints = 120
    const step = Math.max(1, Math.floor(points.length / maxPoints))
    return step > 1 ? points.filter((_, i) => i % step === 0 || i === points.length - 1) : points
  }, [rows])

  if (data.length < 2) {
    return (
      <div className="flex h-[180px] items-center justify-center text-[11px] text-zinc-600">
        Not enough vitals to plot a trend
      </div>
    )
  }

  return (
    <div className="h-[180px] w-full">
      <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
        <LineChart data={data} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" strokeOpacity={0.5} />
          <XAxis
            dataKey="t"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(v: number) => new Date(v).toLocaleDateString([], { weekday: 'short' })}
            tick={{ fill: '#71717a', fontSize: 10 }}
            stroke="#333"
            tickCount={5}
          />
          <YAxis yAxisId="bpm" tick={{ fill: '#71717a', fontSize: 10 }} stroke="#333" />
          <YAxis yAxisId="br" orientation="right" tick={{ fill: '#71717a', fontSize: 10 }} stroke="#333" width={28} />
          <Tooltip
            contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: 8, fontSize: 12, color: '#fff' }}
            labelFormatter={v => fmtTime(v as number)}
            formatter={(value, name) => [value == null ? '—' : Number(value).toFixed(name === 'Breathing' ? 1 : 0), String(name)]}
          />
          <Legend iconType="circle" iconSize={6} wrapperStyle={{ fontSize: 10, color: '#a1a1aa' }} align="center" />
          <Line yAxisId="bpm" type="monotone" dataKey="hr" name="HR" stroke="#fb7185" strokeWidth={1.5} dot={false} activeDot={{ r: 3, fill: '#fb7185' }} connectNulls />
          <Line yAxisId="bpm" type="monotone" dataKey="hrv" name="HRV" stroke="#a78bfa" strokeWidth={1.5} dot={false} activeDot={{ r: 3, fill: '#a78bfa' }} connectNulls />
          <Line yAxisId="br" type="monotone" dataKey="br" name="Breathing" stroke="#2dd4bf" strokeWidth={1} strokeOpacity={0.7} dot={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
