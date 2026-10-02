'use client'

import { useMemo } from 'react'
import { Activity, Heart, Wind } from 'lucide-react'
import {
  Card,
  InlineError,
  LineChart,
  QualityRing,
  SectionLabel,
  Skeleton,
  StageBar,
  StageLegend,
  STAGE_COLORS,
  KeyValue,
} from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'
import { cn } from '@/lib/utils'
import { SleepRecordActions } from '@/src/components/biometrics/SleepRecordActions'
import {
  average,
  downsample,
  formatClock,
  formatDuration,
  formatNightLong,
  formatNightShort,
  groupByNight,
  hypnoTicks,
  keyToDate,
  mainRecord,
  sleepSplit,
  nightKey as toNightKey,
  stageDurations,
  toHypnoBlocks,
  type NightSummary,
  type Side,
  type SleepRecordRow,
} from './sleepData'
import { EmptyNote, NightHypnogram, qualityColor, VitalTile } from './parts'
import { useWeekNights, useWeekRecords } from './useSleepData'

interface NightViewProps {
  side: Side
  weekStart: Date
  isCurrentWeek: boolean
  /** Night chosen from a week bar; null = latest night of the week. */
  nightKey: string | null
  onSelectNight: (key: string) => void
}

export function NightView({ side, weekStart, isCurrentWeek, nightKey, onSelectNight }: NightViewProps) {
  const recordsQuery = useWeekRecords(side, weekStart)
  const records = useMemo(() => (recordsQuery.data ?? []) as SleepRecordRow[], [recordsQuery.data])
  const byNight = useMemo(() => groupByNight(records), [records])
  // Records arrive newest first, so the first one is the latest night.
  const key = nightKey ?? (records[0] ? toNightKey(new Date(records[0].enteredBedAt)) : null)
  const record = key ? mainRecord(byNight.get(key)) : undefined
  // The current week may not hold last night yet (weeks start Sunday), so
  // fall back to the server's "last night" lookup when nothing is picked.
  const useLatest = !record && nightKey === null && isCurrentWeek && !recordsQuery.isLoading
  const stagesQuery = trpc.biometrics.getSleepStages.useQuery(
    record ? { side, sleepRecordId: record.id } : { side },
    { enabled: !!record || useLatest },
  )
  const week = useWeekNights(side, weekStart)

  const stages = (record || useLatest) ? stagesQuery.data : undefined
  const loading = recordsQuery.isLoading || ((!!record || useLatest) && stagesQuery.isLoading)
  const error = recordsQuery.error ?? stagesQuery.error

  const night = useMemo(() => {
    const epochs = stages?.epochs ?? []
    const start = stages?.enteredBedAt ?? (record ? new Date(record.enteredBedAt).getTime() : epochs[0]?.start)
    const lastEpoch = epochs[epochs.length - 1]
    const end = stages?.leftBedAt
      ?? (record?.leftBedAt ? new Date(record.leftBedAt).getTime() : lastEpoch ? lastEpoch.start + lastEpoch.duration : undefined)
    const durations = stageDurations(epochs)
    const asleepMs = durations.rem + durations.light + durations.deep
    const id = record?.id ?? stages?.sleepRecordId ?? null
    return {
      id,
      start: start ?? null,
      end: end ?? null,
      epochs,
      hasStages: epochs.length > 0,
      blocks: start != null && end != null ? toHypnoBlocks(stages?.blocks ?? [], start, end) : [],
      ticks: start != null && end != null ? hypnoTicks(start, end) : [],
      durations,
      asleepSeconds: asleepMs > 0 ? asleepMs / 1000 : record?.sleepDurationSeconds ?? null,
      exits: record?.timesExitedBed ?? records.find(r => r.id === id)?.timesExitedBed ?? null,
      quality: epochs.length > 0 ? stages?.qualityScore ?? null : null,
      distribution: stages?.distribution,
      date: key && record ? keyToDate(key) : start != null ? keyToDate(toNightKey(new Date(start))) : key ? keyToDate(key) : null,
      hr: downsample(epochs.map(e => e.heartRate)),
      // Same chunking as `hr`, over the epochs that have a reading, so each point knows its time.
      hrTimes: downsample(epochs.filter(e => e.heartRate != null).map(e => e.start)),
      avgHr: average(epochs.map(e => e.heartRate)),
      avgHrv: average(epochs.map(e => e.hrv)),
      avgBr: average(epochs.map(e => e.breathingRate)),
    }
  }, [stages, record, records, key])

  const selectedKey = key ?? (night.start != null ? toNightKey(new Date(night.start)) : null)
  const round = (v: number | null) => (v == null ? '—' : Math.round(v))
  const hrValues = epochsHr(night.epochs)

  return (
    <div className="grid items-start gap-4 @min-[960px]:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex min-w-0 flex-col gap-4">
        {loading
          ? <Skeleton className="h-[300px]" />
          : (
              <NightCard
                night={night}
                error={error ? 'Failed to load sleep data' : null}
                empty={night.start == null}
              />
            )}

        <Card className="gap-2.5 px-5">
          <SectionLabel right={hrValues.length > 0 && (
            <span className="font-mono">
              {`min ${Math.round(Math.min(...hrValues))} · avg ${round(night.avgHr)} · max ${Math.round(Math.max(...hrValues))} bpm`}
            </span>
          )}
          >
            <span className="min-[900px]:hidden">Heart rate</span>
            <span className="max-[899px]:hidden">Heart rate through the night</span>
          </SectionLabel>
          {loading
            ? <div className="h-24 animate-pulse rounded-ctl bg-active" />
            : hrValues.length > 1
              ? (
                  <LineChart
                    series={[{ data: night.hr, color: 'var(--chart-hr)', fill: true, width: 1.5 }]}
                    height={96}
                    xLabel={i => (night.hrTimes[i] != null ? new Date(night.hrTimes[i]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '')}
                    format={v => `${Math.round(v)} bpm`}
                  />
                )
              : <EmptyNote className="h-24 py-0">No heart-rate data for this night</EmptyNote>}
        </Card>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <div className="grid grid-cols-3 gap-2">
          <VitalTile
            icon={Heart}
            value={round(night.avgHr)}
            label={(
              <>
                <span className="min-[900px]:hidden">HR · bpm</span>
                <span className="max-[899px]:hidden">Sleeping HR · bpm</span>
              </>
            )}
          />
          <VitalTile icon={Activity} iconClassName="text-cool" value={round(night.avgHrv)} label="HRV · ms" />
          <VitalTile
            icon={Wind}
            iconClassName="text-ok"
            value={round(night.avgBr)}
            label={(
              <>
                <span className="min-[900px]:hidden">br / min</span>
                <span className="max-[899px]:hidden">Breathing · /min</span>
              </>
            )}
          />
        </div>

        <Card className="grid grid-cols-2 gap-3">
          <SectionLabel className="col-span-2">Summary</SectionLabel>
          <KeyValue label="Bedtime" value={formatClock(night.start)} size={16} />
          <KeyValue label="Wake" value={formatClock(night.end)} size={16} />
          <KeyValue label="Asleep" value={formatDuration(night.asleepSeconds)} size={16} />
          <KeyValue label="Bed exits" value={night.exits ?? '—'} size={16} />
        </Card>

        <ThisWeek nights={week.nights} selectedKey={selectedKey} onSelect={onSelectNight} loading={week.isLoading} />
      </div>
    </div>
  )
}

function epochsHr(epochs: Array<{ heartRate: number | null }>): number[] {
  return epochs.map(e => e.heartRate).filter((v): v is number => v != null)
}

interface Night {
  id: number | null
  start: number | null
  end: number | null
  hasStages: boolean
  blocks: ReturnType<typeof toHypnoBlocks>
  ticks: ReturnType<typeof hypnoTicks>
  durations: ReturnType<typeof stageDurations>
  asleepSeconds: number | null
  quality: number | null
  distribution?: { wake: number, rem: number, light: number, deep: number }
  date: Date | null
}

function NightCard({ night, error, empty }: { night: Night, error: string | null, empty: boolean }) {
  if (error) {
    return (
      <Card className="p-5">
        <InlineError>{error}</InlineError>
      </Card>
    )
  }
  if (empty) {
    return (
      <Card className="p-5">
        <EmptyNote className="py-16">No sleep recorded this week</EmptyNote>
      </Card>
    )
  }
  const d = night.distribution
  const fmtStage = (ms: number) => (night.hasStages ? formatDuration(ms / 1000) : '—')
  const durations = {
    awake: fmtStage(night.durations.awake),
    rem: fmtStage(night.durations.rem),
    light: fmtStage(night.durations.light),
    deep: fmtStage(night.durations.deep),
  }
  const times = `${formatClock(night.start)} → ${formatClock(night.end)}`
  const edit = night.id != null && night.start != null && (
    <SleepRecordActions
      recordId={night.id}
      enteredBedAt={new Date(night.start)}
      leftBedAt={night.end != null ? new Date(night.end) : null}
    />
  )
  const ring = (size: number) => (
    <QualityRing
      score={night.quality}
      size={size}
      text={night.quality == null ? '—' : undefined}
      color={qualityColor(night.quality)}
    />
  )

  return (
    <Card className="gap-3.5 p-4 min-[900px]:gap-[18px] min-[900px]:p-5">
      {/* Phone: ring + date/duration/times stacked. Desktop: one line, ring moves down. */}
      <div className="flex items-center gap-4 min-[900px]:gap-2.5">
        <div className="min-[900px]:hidden">{ring(76)}</div>
        <div className="flex min-w-0 flex-col gap-0.5 min-[900px]:flex-row min-[900px]:items-center min-[900px]:gap-2.5">
          <span className="text-[15px] font-medium min-[900px]:hidden">{night.date ? formatNightShort(night.date) : '—'}</span>
          <span className="text-base font-medium max-[899px]:hidden">{night.date ? formatNightLong(night.date) : '—'}</span>
          <span className="font-mono text-xl font-light min-[900px]:hidden">{formatDuration(night.asleepSeconds)}</span>
          <span className="font-mono text-xs text-fg-2">{times}</span>
        </div>
        <div className="ml-auto self-start min-[900px]:self-center">{edit}</div>
      </div>

      <div className="flex items-center gap-7">
        <div className="hidden min-[900px]:block">{ring(96)}</div>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {d && night.hasStages
            ? <StageBar awake={d.wake} rem={d.rem} light={d.light} deep={d.deep} height={10} />
            : <div className="h-2.5 rounded-[5px] bg-active" />}
          <div className="max-[899px]:hidden">
            <StageLegend durations={durations} />
          </div>
        </div>
      </div>

      {night.hasStages
        ? (
            <>
              <div className="max-[899px]:hidden">
                <NightHypnogram blocks={night.blocks} ticks={night.ticks} />
              </div>
              <div className="min-[900px]:hidden">
                <NightHypnogram blocks={night.blocks} lane={18} bar={12} labels={false} />
              </div>
            </>
          )
        : <EmptyNote className="py-6">Not enough vitals to classify stages for this night</EmptyNote>}

      <div className="grid grid-cols-4 gap-1.5 text-xs text-fg-2 min-[900px]:hidden">
        {(['awake', 'rem', 'light', 'deep'] as const).map(k => (
          <div key={k}>
            {k === 'awake' ? 'Awake' : k === 'rem' ? 'REM' : k === 'light' ? 'Light' : 'Deep'}
            <div className="font-mono text-[13px] text-fg">{durations[k]}</div>
          </div>
        ))}
      </div>
    </Card>
  )
}

/** Seven stacked mini bars; tapping one opens that night. */
function ThisWeek({ nights, selectedKey, onSelect, loading }: {
  nights: NightSummary[]
  selectedKey: string | null
  onSelect: (key: string) => void
  loading: boolean
}) {
  const withData = nights.filter(n => n.hours > 0)
  const avg = withData.length ? withData.reduce((s, n) => s + n.hours, 0) / withData.length : null
  const maxHours = Math.max(9, ...nights.map(n => n.hours))
  return (
    <Card>
      <SectionLabel right={avg != null && <span className="font-mono">{`avg ${formatDuration(avg * 3600)}`}</span>}>
        This week
      </SectionLabel>
      <div className={cn('grid h-[150px] grid-cols-7 gap-2', loading && 'animate-pulse')}>
        {nights.map((n) => {
          const on = n.key === selectedKey
          const parts = sleepSplit(n.distribution) ?? { rem: 21, light: 54, deep: 25 }
          const h = n.hours / maxHours
          return (
            <button
              key={n.key}
              type="button"
              aria-label={`${formatNightShort(n.date)}${n.hours > 0 ? `, ${formatDuration(n.hours * 3600)}` : ', no data'}`}
              aria-pressed={on}
              disabled={n.hours <= 0}
              onClick={() => onSelect(n.key)}
              className="flex min-w-0 cursor-pointer flex-col items-center gap-1.5 border-0 bg-transparent p-0 disabled:cursor-default"
            >
              <div className="flex w-full max-w-14 flex-1 flex-col justify-end gap-0.5" style={{ opacity: on ? 1 : 0.55 }}>
                {n.hours > 0
                  ? (
                      <>
                        <span className="rounded-t-[2px]" style={{ height: `${h * parts.rem}%`, background: STAGE_COLORS.rem }} />
                        <span style={{ height: `${h * parts.light}%`, background: STAGE_COLORS.light }} />
                        <span className="rounded-b-[2px]" style={{ height: `${h * parts.deep}%`, background: STAGE_COLORS.deep }} />
                      </>
                    )
                  : <span className="h-0.5 rounded-[1px] bg-line-2" />}
              </div>
              <span className={cn('font-mono text-[10px]', on ? 'text-fg' : 'text-fg-2')}>
                {n.date.toLocaleDateString('en-US', { weekday: 'narrow' })}
              </span>
            </button>
          )
        })}
      </div>
    </Card>
  )
}
