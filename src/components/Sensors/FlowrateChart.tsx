'use client'

import { useMemo, useState } from 'react'
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
import { Droplets } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSensorFrame } from '@/src/hooks/useSensorStream'

interface FlowChartDataPoint {
  time: number
  leftFlow: number | null
  rightFlow: number | null
  leftRpm: number | null
  rightRpm: number | null
}

function formatTime(timestamp: string | Date | number): string {
  const d = new Date(timestamp)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatTooltipTime(timestamp: number): string {
  const d = new Date(timestamp)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

type ViewMode = 'flowrate' | 'rpm'

/**
 * Flowrate and pump RPM chart.
 * Queries historical flow readings from the biometrics DB and displays
 * left/right flowrate (centidegrees) or pump RPM over time.
 * Also shows live data from the frzHealth WebSocket frame.
 */
export function FlowrateChart() {
  const [hours, setHours] = useState(6)
  const [viewMode, setViewMode] = useState<ViewMode>('flowrate')

  const frzHealth = useSensorFrame('frzHealth')

  const flowQuery = trpc.waterLevel.getFlowReadings.useQuery(
    { hours },
    {
      refetchInterval: 60_000,
      staleTime: 30_000,
    },
  )

  const chartData = useMemo(() => {
    const raw = flowQuery.data as Array<{
      timestamp: Date | string
      leftFlowrateCd: number | null
      rightFlowrateCd: number | null
      leftPumpRpm: number | null
      rightPumpRpm: number | null
    }> | undefined

    if (!raw || raw.length === 0) return []

    // Data is already in chronological order from the API
    const points: FlowChartDataPoint[] = raw.map(d => ({
      time: new Date(d.timestamp).getTime(),
      leftFlow: d.leftFlowrateCd,
      rightFlow: d.rightFlowrateCd,
      leftRpm: d.leftPumpRpm,
      rightRpm: d.rightPumpRpm,
    }))

    // Downsample to ~120 points for performance
    const maxPoints = 120
    const step = Math.max(1, Math.floor(points.length / maxPoints))
    return step > 1
      ? points.filter((_, i) => i % step === 0 || i === points.length - 1)
      : points
  }, [flowQuery.data])

  const leftKey = viewMode === 'flowrate' ? 'leftFlow' as const : 'leftRpm' as const
  const rightKey = viewMode === 'flowrate' ? 'rightFlow' as const : 'rightRpm' as const
  const unitLabel = viewMode === 'flowrate' ? 'cd' : 'RPM'

  // Compute Y-axis domain
  const allValues = chartData.flatMap(d => [d[leftKey], d[rightKey]].filter((v): v is number => v !== null))
  const minVal = allValues.length > 0 ? Math.floor(Math.min(...allValues)) - 1 : 0
  const maxVal = allValues.length > 0 ? Math.ceil(Math.max(...allValues)) + 1 : 100
  const domain: [number, number] = [Math.max(0, minVal), maxVal]

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Droplets size={10} className="text-blue-400" />
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            {viewMode === 'flowrate' ? 'Flow Rate' : 'Pump RPM'}
          </h3>
        </div>

        <div className="flex items-center gap-1.5">
          {/* View mode toggle */}
          <div className="flex rounded-md bg-zinc-800">
            <button
              onClick={() => setViewMode('flowrate')}
              className={`rounded-md px-2 py-0.5 text-[9px] font-medium transition-colors ${
                viewMode === 'flowrate' ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-500'
              }`}
            >
              Flow
            </button>
            <button
              onClick={() => setViewMode('rpm')}
              className={`rounded-md px-2 py-0.5 text-[9px] font-medium transition-colors ${
                viewMode === 'rpm' ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-500'
              }`}
            >
              RPM
            </button>
          </div>

          {/* Time range selector */}
          <select
            value={hours}
            onChange={e => setHours(Number(e.target.value))}
            className="rounded-md bg-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-400 outline-none"
          >
            <option value={1}>1h</option>
            <option value={6}>6h</option>
            <option value={24}>24h</option>
            <option value={72}>3d</option>
            <option value={168}>7d</option>
          </select>
        </div>
      </div>

      {/* Live values from WebSocket */}
      {frzHealth && (
        <div className="grid grid-cols-[auto_1fr_1fr] gap-x-2 gap-y-1 items-center">
          <div />
          <div className="text-center text-[9px] font-semibold text-sky-400">Left</div>
          <div className="text-center text-[9px] font-semibold text-teal-400">Right</div>

          <div className="flex items-center gap-1 text-blue-400">
            <Droplets size={10} />
            <span className="text-[9px] font-medium">Flow</span>
          </div>
          <div className="rounded-md bg-zinc-800/50 px-2 py-1 text-center text-[11px] font-medium tabular-nums text-zinc-200">
            {frzHealth.left.flowrate !== null ? `${frzHealth.left.flowrate.toFixed(1)}` : '--'}
          </div>
          <div className="rounded-md bg-zinc-800/50 px-2 py-1 text-center text-[11px] font-medium tabular-nums text-zinc-200">
            {frzHealth.right.flowrate !== null ? `${frzHealth.right.flowrate.toFixed(1)}` : '--'}
          </div>
        </div>
      )}

      {/* Historical chart */}
      {flowQuery.isLoading
        ? (
            <div className="flex h-[180px] items-center justify-center">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
            </div>
          )
        : flowQuery.isError
          ? (
              <div className="flex h-[180px] items-center justify-center text-sm text-red-400">
                Failed to load flow data
              </div>
            )
          : chartData.length === 0
            ? (
                <div className="flex h-[180px] items-center justify-center text-sm text-zinc-500">
                  No flow data available
                </div>
              )
            : (
                <div className="h-[180px] w-full">
                  <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                    <LineChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#333" strokeOpacity={0.5} />
                      <XAxis
                        dataKey="time"
                        type="number"
                        domain={['dataMin', 'dataMax']}
                        tickFormatter={(v: number) => formatTime(v)}
                        tick={{ fill: '#71717a', fontSize: 10 }}
                        stroke="#333"
                        tickCount={4}
                      />
                      <YAxis
                        domain={domain}
                        tick={{ fill: '#71717a', fontSize: 10 }}
                        stroke="#333"
                        tickFormatter={(v: number) => `${Math.round(v)}`}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#1a1a1a',
                          border: '1px solid #333',
                          borderRadius: 8,
                          fontSize: 12,
                          color: '#fff',
                        }}
                        labelFormatter={v => formatTooltipTime(v as number)}
                        formatter={(value, name) => [
                          `${Number(value).toFixed(1)} ${unitLabel}`,
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
                        dataKey={leftKey}
                        name="Left"
                        stroke="#5cb8e0"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 3, fill: '#5cb8e0' }}
                        connectNulls
                      />
                      <Line
                        type="monotone"
                        dataKey={rightKey}
                        name="Right"
                        stroke="#40e0d0"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 3, fill: '#40e0d0' }}
                        connectNulls
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
    </div>
  )
}
