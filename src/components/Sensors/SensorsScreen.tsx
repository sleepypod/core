'use client'

import { useMemo, useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { Card, InlineError, SectionLabel, SegmentedControl, Skeleton } from '@/src/components/ds'
import { getDateRangeFromTimeRange, type TimeRange } from '@/src/components/Environment/TimeRangeSelector'
import { BedTempChart } from '@/src/components/Environment/BedTempChart'
import { HumidityChart } from '@/src/components/Environment/HumidityChart'
import { PresenceCard } from './PresenceCard'
import { BedTempMatrix } from './BedTempMatrix'
import { FreezerHealthCard } from './FreezerHealthCard'
import { FlowrateChart } from './FlowrateChart'
import { PiezoWaveform } from './PiezoWaveform'

const TREND_RANGES: ReadonlyArray<{ value: TimeRange, label: string }> = [
  { value: '1h', label: '1h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
]

/**
 * System → Sensors tab: live sensor cards on a responsive grid
 * (3 columns when the content area allows, 2 on tablets, 1 on phones).
 * The WebSocket connection and the Stop/Start toggle live in SystemScreen.
 */
export function SensorsScreen({ streamEnabled = true }: { streamEnabled?: boolean }) {
  const [timeRange, setTimeRange] = useState<TimeRange>('6h')

  const dateRange = useMemo(
    () => getDateRangeFromTimeRange(timeRange),
    [timeRange],
  )

  const limit = useMemo(() => {
    const hours = parseInt(timeRange)
    return Math.min(hours * 60, 1440)
  }, [timeRange])

  // Historical bed temp feeds both the trend and the humidity chart
  const bedTempQuery = trpc.environment.getBedTemp.useQuery(
    {
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      limit,
      unit: 'F',
    },
    {
      refetchInterval: 60_000,
      staleTime: 30_000,
    },
  )

  const summaryQuery = trpc.environment.getSummary.useQuery(
    {
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      unit: 'F',
    },
    { staleTime: 60_000 },
  )
  const summary = summaryQuery.data?.bedTemp

  return (
    <div className="grid grid-flow-row-dense gap-3.5 @min-[640px]:grid-cols-2 @min-[960px]:grid-cols-3">
      <PresenceCard />
      <BedTempMatrix />
      <FreezerHealthCard />

      {/* Bed temperature trend */}
      <Card className="gap-2.5 px-4 py-3.5 @min-[640px]:col-span-2">
        <SectionLabel
          className="flex-wrap gap-x-3.5"
          right={(
            <SegmentedControl
              size="sm"
              ariaLabel="Trend range"
              options={TREND_RANGES}
              value={timeRange}
              onChange={setTimeRange}
              className="rounded-thumb p-0.5 font-mono [&>button]:rounded-[4px] [&>button]:px-2 [&>button]:py-0.5"
            />
          )}
        >
          Bed temperature
          <LegendSwatch color="var(--accent-cool)" label="Left" />
          <LegendSwatch color="var(--accent-warm)" label="Right" />
          <LegendSwatch color="var(--text-3)" label="Ambient" dashed />
        </SectionLabel>

        {bedTempQuery.isLoading
          ? <Skeleton className="h-[170px]" />
          : bedTempQuery.isError
            ? <InlineError className="flex h-[170px] items-center justify-center">Failed to load temperature data</InlineError>
            : (
                <BedTempChart
                  data={bedTempQuery.data ?? []}
                  unit="F"
                  showAmbient
                  highlightSide="both"
                />
              )}

        {/* Phones: summary stats instead of the axis-heavy desktop chart */}
        {summary && (
          <div className="grid grid-cols-4 gap-1 border-t border-line pt-2.5 font-mono text-xs min-[900px]:hidden">
            <SummaryItem label="Avg L" value={summary.avgLeftCenterTemp != null ? `${Math.round(summary.avgLeftCenterTemp)}°` : '--'} />
            <SummaryItem label="Avg R" value={summary.avgRightCenterTemp != null ? `${Math.round(summary.avgRightCenterTemp)}°` : '--'} />
            <SummaryItem label="Ambient" value={summary.avgAmbientTemp != null ? `${Math.round(summary.avgAmbientTemp)}°` : '--'} />
            <SummaryItem label="Humidity" value={summary.avgHumidity != null ? `${Math.round(summary.avgHumidity)}%` : '--'} />
          </div>
        )}
      </Card>

      {/* Humidity */}
      <Card className="gap-2.5 px-4 py-3.5">
        {bedTempQuery.isLoading
          ? (
              <>
                <SectionLabel>Humidity</SectionLabel>
                <Skeleton className="h-[130px]" />
              </>
            )
          : <HumidityChart data={bedTempQuery.data ?? []} />}
      </Card>

      <PiezoWaveform enabled={streamEnabled} className="@min-[640px]:col-span-2" />
      <FlowrateChart />
    </div>
  )
}

function LegendSwatch({ color, label, dashed }: { color: string, label: string, dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1.5 tracking-normal normal-case max-[899px]:hidden">
      <span
        className="block w-2.5"
        style={dashed ? { borderTop: `2px dashed ${color}` } : { height: 2, background: color }}
      />
      {label}
    </span>
  )
}

function SummaryItem({ label, value }: { label: string, value: string }) {
  return (
    <div>
      {value}
      <div className="font-sans text-[10px] text-fg-2">{label}</div>
    </div>
  )
}
