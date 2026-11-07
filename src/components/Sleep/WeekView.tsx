'use client'

import { useTimeFormatter } from '@/src/hooks/useTimeFormatter'

import { Card, CardHeader, InlineError, KeyValue, LineChart, SectionLabel, Skeleton, StageLegend, WeekBars } from '@/src/components/ds'
import { MovementChart } from '@/src/components/MovementChart/MovementChart'
import {
  average,
  averageClock,
  formatDuration,
  formatNightLong,
  nightWindow,
  toHypnoBlocks,
  toWeekNights,
  type NightSummary,
  type Side,
} from './sleepData'
import { EmptyNote, NightHypnogram } from './parts'
import { useWeekNights } from './useSleepData'

interface WeekViewProps {
  side: Side
  weekStart: Date
  nightKey: string | null
  onSelectNight: (key: string) => void
}

export function WeekView({ side, weekStart, nightKey, onSelectNight }: WeekViewProps) {
  const { formatClock } = useTimeFormatter()
  const { nights, isLoading, error } = useWeekNights(side, weekStart)
  const withData = nights.filter(n => n.hours > 0)
  const picked = nights.findIndex(n => n.key === nightKey)
  const lastWithData = nights.findLastIndex(n => n.hours > 0)
  const selected = picked >= 0 ? picked : lastWithData >= 0 ? lastWithData : nights.length - 1
  const night = nights[selected]
  const select = (i: number) => onSelectNight(nights[i].key)

  return (
    <div className="grid items-start gap-4 @min-[960px]:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex min-w-0 flex-col gap-3.5">
        <Card>
          <CardHeader title="Recorded bed time" />
          <p className="text-xs text-fg-2">Includes awake and unstaged time. Select a night for estimated stages and unknown gaps.</p>
          {isLoading
            ? <div className="h-[230px] animate-pulse rounded-ctl bg-active" />
            : error
              ? <InlineError>Failed to load sleep data</InlineError>
              : (
                  <>
                    <div className="max-[899px]:hidden">
                      <WeekBars nights={toWeekNights(nights, true)} selected={selected} onSelect={select} height={190} detailed />
                    </div>
                    <div className="min-[900px]:hidden">
                      <WeekBars nights={toWeekNights(nights, false)} selected={selected} onSelect={select} height={115} />
                    </div>
                    {withData.length === 0 && <p className="text-center text-[13px] text-fg-2">No sleep recorded this week</p>}
                  </>
                )}
        </Card>

        {night?.record && <NightDrillIn night={night} />}

        <MovementChart showSleepStatistics={false} range={nightWindow(weekStart, 7)} />
      </div>

      <div className="flex min-w-0 flex-col gap-3.5">
        <Card>
          <SectionLabel>Week averages</SectionLabel>
          <div className="grid grid-cols-2 gap-3">
            <KeyValue label="Recorded bed time" value={formatDuration((average(withData.map(n => n.hours)) ?? 0) * 3600)} />
            <KeyValue label="Estimated sleep" value={formatEstimated(average(withData.map(n => n.asleepSeconds ?? null)))} />
            <KeyValue label="Quality" value={fmt(average(withData.map(n => n.quality)))} />
            <KeyValue label="Bedtime" value={formatClock(averageClock(withData.map(n => n.bedtime)))} />
            <KeyValue label="Wake" value={formatClock(averageClock(withData.map(n => n.wake)))} />
          </div>
          <p className="text-xs text-fg-2">{`${withData.filter(night => night.asleepSeconds != null).length} of ${withData.length} recorded nights have stage estimates. Missing estimates are not zero sleep.`}</p>
        </Card>

        <Card>
          <SectionLabel>Vitals by night</SectionLabel>
          <VitalsRow label="Sleeping HR" unit="bpm" color="var(--chart-hr)" nights={nights} pick={n => n.hr} />
          <VitalsRow label="HRV" unit="ms" color="var(--accent-cool)" nights={nights} pick={n => n.hrv} />
          <VitalsRow label="Breathing" unit="/min" color="var(--status-ok)" nights={nights} pick={n => n.br} />
        </Card>
      </div>
    </div>
  )
}

const fmt = (v: number | null) => (v == null ? '—' : Math.round(v))

function VitalsRow({ label, unit, color, nights, pick }: {
  label: string
  unit: string
  color: string
  nights: NightSummary[]
  pick: (n: NightSummary) => number | null
}) {
  const values = nights.map(n => pick(n) ?? Number.NaN)
  const points = values.filter(Number.isFinite).length
  return (
    <div className="grid grid-cols-[90px_minmax(0,1fr)_44px] items-center gap-3 border-t border-line pt-2.5">
      <span className="text-[13px]">
        {label}
        <span className="text-[11px] text-fg-2">{` ${unit}`}</span>
      </span>
      {points > 1
        ? <LineChart series={[{ data: values, color }]} height={30} />
        : <span className="h-[30px] border-b border-dashed border-line-2" />}
      <span className="text-right font-mono text-sm">{fmt(average(values.filter(Number.isFinite)))}</span>
    </div>
  )
}

const formatEstimated = (seconds: number | null) => seconds === 0 ? '0m' : formatDuration(seconds)

function NightDrillIn({ night }: { night: NightSummary }) {
  const { formatClock } = useTimeFormatter()
  const stages = night.analysis
  const start = night.bedtime?.getTime()
  const end = night.wake?.getTime()
  const recording = stages?.recording
  const meta = [
    `${formatClock(start)} → ${formatClock(end)}`,
    `${formatDuration(night.hours * 3600)} recorded`,
    night.quality != null ? `quality ${night.quality}` : null,
  ].filter(Boolean).join(' · ')

  return (
    <Card data-testid="week-night-detail">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-[15px] font-medium">{formatNightLong(night.date)}</span>
        <span className="font-mono text-xs text-fg-2">{meta}</span>
      </div>
      <p className="text-xs text-fg-2">{`Estimated sleep · recorded segments: ${formatEstimated(night.asleepSeconds ?? null)}`}</p>
      {recording && <p className="text-xs text-fg-2">{`${recording.recordIds.length} recording segments · ${recording.gapsMs === 0 ? '0m' : formatDuration(recording.gapsMs / 1000)} between segments, not counted. Gaps remain unknown.`}</p>}
      {night.analysisLoading
        ? <Skeleton className="h-[88px] rounded-ctl" />
        : night.analysisError
          ? <InlineError>Failed to load sleep stages</InlineError>
          : stages && stages.epochs.length > 0 && start != null && end != null
            ? <NightHypnogram blocks={toHypnoBlocks(stages.blocks, start, end)} lane={22} bar={14} labels={false} />
            : <EmptyNote className="py-6">Not enough vitals to classify stages for this night</EmptyNote>}
      <StageLegend />
    </Card>
  )
}
