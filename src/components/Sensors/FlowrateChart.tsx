'use client'

import { useMemo, useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { useSensorFrame } from '@/src/hooks/useSensorStream'
import { Card, InlineError, LineChart, SectionLabel, SegmentedControl, SelectValue, Skeleton } from '@/src/components/ds'

interface FlowChartDataPoint {
  time: number
  leftFlow: number | null
  rightFlow: number | null
  leftRpm: number | null
  rightRpm: number | null
}

type ViewMode = 'flowrate' | 'rpm'

const HOUR_OPTIONS = [
  { value: 1, label: '1h' },
  { value: 6, label: '6h' },
  { value: 24, label: '24h' },
  { value: 72, label: '3d' },
  { value: 168, label: '7d' },
] as const

/**
 * Flow rate / pump RPM card.
 * Live left/right values from the frzHealth WebSocket frame, plus the
 * historical flow readings from the biometrics DB as a compact trend.
 */
export function FlowrateChart() {
  const [hours, setHours] = useState<number>(6)
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

    // Data is already in chronological order from the API.
    // leftFlowrateCd/rightFlowrateCd are stored as raw×100 to keep the table
    // integer-typed; divide back so the chart and the live readout share a unit.
    const points: FlowChartDataPoint[] = raw.map(d => ({
      time: new Date(d.timestamp).getTime(),
      leftFlow: d.leftFlowrateCd != null ? d.leftFlowrateCd / 100 : null,
      rightFlow: d.rightFlowrateCd != null ? d.rightFlowrateCd / 100 : null,
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

  const live = frzHealth
    ? viewMode === 'flowrate'
      ? {
          left: frzHealth.left.flowrate !== null ? frzHealth.left.flowrate.toFixed(2) : '--',
          right: frzHealth.right.flowrate !== null ? frzHealth.right.flowrate.toFixed(2) : '--',
        }
      : { left: frzHealth.left.pumpRpm.toLocaleString(), right: frzHealth.right.pumpRpm.toLocaleString() }
    : { left: '--', right: '--' }
  const unitLabel = viewMode === 'flowrate' ? 'flow' : 'rpm'

  return (
    <Card className="gap-2.5 px-4 py-3.5">
      <SectionLabel
        right={(
          <span className="flex items-center gap-1.5">
            <SegmentedControl
              size="sm"
              ariaLabel="Flow view"
              options={[{ value: 'flowrate', label: 'Flow' }, { value: 'rpm', label: 'RPM' }]}
              value={viewMode}
              onChange={setViewMode}
              className="rounded-thumb p-0.5 font-mono [&>button]:rounded-[4px] [&>button]:px-2 [&>button]:py-0.5"
            />
            <SelectValue label="Flow history range" value={hours} options={HOUR_OPTIONS} onChange={setHours} className="[&_select]:py-1 [&_select]:text-xs" />
          </span>
        )}
      >
        {viewMode === 'flowrate' ? 'Flow rate' : 'Pump rpm'}
      </SectionLabel>

      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <div className="font-mono text-lg font-light">{live.left}</div>
          <div className="text-[11px] text-fg-2">{`Left · ${unitLabel}`}</div>
        </div>
        <div>
          <div className="font-mono text-lg font-light">{live.right}</div>
          <div className="text-[11px] text-fg-2">{`Right · ${unitLabel}`}</div>
        </div>
      </div>

      {flowQuery.isLoading
        ? <Skeleton className="h-14" />
        : flowQuery.isError
          ? <InlineError>Failed to load flow data</InlineError>
          : chartData.length < 2
            ? <p className="text-xs text-fg-3">No flow history</p>
            : (
                <LineChart
                  height={56}
                  series={[
                    { data: chartData.map(d => d[leftKey] ?? Number.NaN), color: 'var(--accent-cool)', width: 1.5 },
                    { data: chartData.map(d => d[rightKey] ?? Number.NaN), color: 'var(--accent-warm)', width: 1.5 },
                  ]}
                  xLabel={i => new Date(chartData[i].time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  format={v => (viewMode === 'flowrate' ? v.toFixed(2) : Math.round(v).toLocaleString())}
                />
              )}
    </Card>
  )
}
