'use client'

import { Card, CardHeader, InlineError, KeyValue, LineChart, SectionLabel, Skeleton, StageLegend, WeekBars } from '@/src/components/ds'
import { MovementChart } from '@/src/components/MovementChart/MovementChart'
import { trpc } from '@/src/utils/trpc'
import {
  average,
  averageClock,
  formatClock,
  formatDuration,
  formatNightLong,
  toHypnoBlocks,
  toWeekNights,
  type NightSummary,
  type Side,
  type SleepRecordRow,
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
          <CardHeader className="max-[899px]:hidden" title="Sleep timeline" right={<StageLegend />} />
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
          <div className="min-[900px]:hidden">
            <StageLegend />
          </div>
        </Card>

        {night?.record && <NightDrillIn side={side} night={night} record={night.record} />}

        <MovementChart />
      </div>

      <div className="flex min-w-0 flex-col gap-3.5">
        <Card>
          <SectionLabel>Week averages</SectionLabel>
          <div className="grid grid-cols-2 gap-3">
            <KeyValue label="Asleep" value={formatDuration((average(withData.map(n => n.hours)) ?? 0) * 3600)} />
            <KeyValue label="Quality" value={fmt(average(withData.map(n => n.quality)))} />
            <KeyValue label="Bedtime" value={formatClock(averageClock(withData.map(n => n.bedtime)))} />
            <KeyValue label="Wake" value={formatClock(averageClock(withData.map(n => n.wake)))} />
          </div>
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

function NightDrillIn({ side, night, record }: { side: Side, night: NightSummary, record: SleepRecordRow }) {
  const stages = trpc.biometrics.getSleepStages.useQuery({ side, sleepRecordId: record.id })
  const start = new Date(record.enteredBedAt).getTime()
  const end = record.leftBedAt ? new Date(record.leftBedAt).getTime() : start + record.sleepDurationSeconds * 1000
  const quality = stages.data?.epochs.length ? stages.data.qualityScore : night.quality
  const meta = [
    `${formatClock(start)} → ${formatClock(end)}`,
    formatDuration(night.hours * 3600),
    quality != null ? `quality ${quality}` : null,
  ].filter(Boolean).join(' · ')

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-[15px] font-medium">{formatNightLong(night.date)}</span>
        <span className="font-mono text-xs text-fg-2">{meta}</span>
      </div>
      {stages.isLoading
        ? <Skeleton className="h-[88px] rounded-ctl" />
        : stages.error
          ? <InlineError>Failed to load sleep stages</InlineError>
          : stages.data && stages.data.epochs.length > 0
            ? <NightHypnogram blocks={toHypnoBlocks(stages.data.blocks, start, end)} lane={22} bar={14} labels={false} />
            : <EmptyNote className="py-6">Not enough vitals to classify stages for this night</EmptyNote>}
      <StageLegend />
    </Card>
  )
}
