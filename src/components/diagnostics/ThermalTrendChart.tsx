'use client'

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

import { fmtF, type ThermalTrendPoint } from './diagnosticsLogic'

export type { ThermalTrendPoint }

const SIDE_COLOR = { left: '#5cb8e0', right: '#40e0d0' } as const

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/**
 * Per-side temperature trend for the Thermal page. The whole point is to make a
 * stalled pump visible: when flow stops, `water` and `bed` flatline away from
 * `target` even though the side reads as powered. A snapshot can't show that —
 * the divergence over time can.
 */
export function ThermalTrendChart({ side, points }: { side: 'left' | 'right', points: ThermalTrendPoint[] }) {
  if (points.length < 2) {
    return (
      <div className="flex h-[160px] items-center justify-center text-[11px] text-zinc-600">
        Collecting samples… (updates every 5s)
      </div>
    )
  }

  const temps = points.flatMap(p => [p.target, p.bed, p.water].filter((v): v is number => v != null))
  // An off side reports null target/bed (no level-0 phantom), so a window with
  // no water reading either leaves temps empty — Math.min/max would then yield
  // ±Infinity and hand the Y-axis an invalid domain.
  if (temps.length === 0) {
    return (
      <div className="flex h-[160px] items-center justify-center text-[11px] text-zinc-600">
        No temperature data yet
      </div>
    )
  }
  const min = Math.floor(Math.min(...temps) - 2)
  const max = Math.ceil(Math.max(...temps) + 2)
  const color = SIDE_COLOR[side]

  return (
    <div className="h-[160px] w-full">
      <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
        <LineChart data={points} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" strokeOpacity={0.5} />
          <XAxis
            dataKey="t"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={fmtTime}
            tick={{ fill: '#71717a', fontSize: 10 }}
            stroke="#333"
            tickCount={4}
          />
          <YAxis
            domain={[min, max]}
            tick={{ fill: '#71717a', fontSize: 10 }}
            stroke="#333"
            tickFormatter={(v: number) => `${Math.round(v)}°`}
          />
          <Tooltip
            contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: 8, fontSize: 12, color: '#fff' }}
            labelFormatter={v => new Date(v as number).toLocaleTimeString()}
            formatter={(value, name) => [fmtF(value == null ? null : Number(value)), String(name)]}
          />
          <Legend iconType="circle" iconSize={6} wrapperStyle={{ fontSize: 10, color: '#a1a1aa' }} align="center" />
          <Line type="monotone" dataKey="target" name="Target" stroke="#d4a84a" strokeWidth={1} strokeDasharray="4 2" dot={false} connectNulls />
          <Line type="monotone" dataKey="bed" name="Bed" stroke={color} strokeWidth={2} dot={false} activeDot={{ r: 3, fill: color }} connectNulls />
          <Line type="monotone" dataKey="water" name="Water" stroke={color} strokeWidth={1} strokeOpacity={0.45} dot={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
