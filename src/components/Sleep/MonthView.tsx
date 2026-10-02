'use client'

import { useMemo } from 'react'
import { Card, InlineError, KeyValue, SectionLabel } from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'
import { cn } from '@/lib/utils'
import {
  dayKey,
  daysInMonth,
  formatDuration,
  formatNightShort,
  formatRange,
  groupByNight,
  heatAlpha,
  keyToDate,
  monthCells,
  monthWeeks,
  nightWindow,
  type Side,
  type SleepRecordRow,
} from './sleepData'
import { EmptyNote } from './parts'

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

interface MonthNight {
  key: string
  date: Date
  hours: number
  exits: number
}

export function MonthView({ side, month }: { side: Side, month: Date }) {
  const range = useMemo(() => nightWindow(month, daysInMonth(month)), [month])
  const query = trpc.biometrics.getSleepRecords.useQuery({ side, ...range, limit: 100 })

  const nights = useMemo<MonthNight[]>(() => {
    const byNight = groupByNight((query.data ?? []) as SleepRecordRow[])
    return [...byNight.entries()]
      .map(([key, recs]) => ({
        key,
        date: keyToDate(key),
        hours: recs.reduce((s, r) => s + r.sleepDurationSeconds, 0) / 3600,
        exits: recs.reduce((s, r) => s + r.timesExitedBed, 0),
      }))
      .sort((a, b) => b.key.localeCompare(a.key))
  }, [query.data])
  const byKey = useMemo(() => new Map(nights.map(n => [n.key, n])), [nights])

  const monthName = month.toLocaleDateString('en-US', { month: 'long' })
  const avgHours = nights.length ? nights.reduce((s, n) => s + n.hours, 0) / nights.length : null
  const avgExits = nights.length ? nights.reduce((s, n) => s + n.exits, 0) / nights.length : null

  const stats = (className?: string) => (
    <Card className={className}>
      <SectionLabel>{monthName}</SectionLabel>
      <div className="grid grid-cols-3 gap-3">
        <KeyValue label="Nights" value={query.isLoading ? '—' : nights.length} />
        <KeyValue label="Avg sleep" value={avgHours == null ? '—' : `${avgHours.toFixed(1)}h`} />
        <KeyValue label="Avg exits" value={avgExits == null ? '—' : avgExits.toFixed(1)} />
      </div>
    </Card>
  )

  const weeks = monthWeeks(month).map((w) => {
    const inWeek: MonthNight[] = []
    for (let d = new Date(w.start); d <= w.end; d.setDate(d.getDate() + 1)) {
      const n = byKey.get(dayKey(d))
      if (n) inWeek.push(n)
    }
    const avg = inWeek.length ? inWeek.reduce((s, n) => s + n.hours, 0) / inWeek.length : null
    return { label: formatRange(w.start, w.end), avg }
  })

  return (
    <div className="grid items-start gap-4 @min-[960px]:grid-cols-[minmax(0,1fr)_300px]">
      {stats('@min-[960px]:hidden')}

      <Card>
        <div className="flex items-center">
          <span className="text-[15px] font-medium">Hours asleep</span>
          <span className="ml-auto flex items-center gap-2 text-xs text-fg-2">
            5h
            <span
              className="h-2 w-20 rounded"
              style={{ background: 'linear-gradient(90deg, rgba(var(--heat-rgb), 0.1), rgba(var(--heat-rgb), 0.6))' }}
            />
            8h
          </span>
        </div>
        {query.error
          ? <InlineError>Failed to load sleep data</InlineError>
          : <Calendar month={month} byKey={byKey} loading={query.isLoading} />}
      </Card>

      <div className="flex min-w-0 flex-col gap-3.5 @min-[960px]:col-start-2 @min-[960px]:row-start-1">
        {stats('hidden @min-[960px]:flex')}

        <Card>
          <SectionLabel>Average by week</SectionLabel>
          {weeks.map(w => (
            <div key={w.label} className="grid grid-cols-[104px_minmax(0,1fr)_56px] items-center gap-2.5">
              <span className="whitespace-nowrap font-mono text-[11px] text-fg-2">{w.label}</span>
              <div className="h-2 rounded bg-line">
                {w.avg != null && <div className="h-2 rounded bg-cool" style={{ width: `${Math.min(100, (w.avg / 9) * 100)}%` }} />}
              </div>
              <span className="text-right font-mono text-xs">{w.avg == null ? '—' : formatDuration(w.avg * 3600)}</span>
            </div>
          ))}
        </Card>

        <Card>
          <SectionLabel>Nights</SectionLabel>
          {nights.length === 0
            ? <EmptyNote className="py-4">{query.isLoading ? 'Loading…' : 'No nights recorded this month'}</EmptyNote>
            : (
                <div className="flex max-h-[320px] flex-col gap-3 overflow-y-auto">
                  {nights.map(n => (
                    <div key={n.key} className="flex items-center gap-3 border-t border-line pt-3">
                      <span className="flex-1 text-[13px]">{formatNightShort(n.date).replace(/^(\w+) /, '$1, ')}</span>
                      <span className="font-mono text-[13px]">{formatDuration(n.hours * 3600)}</span>
                      <span className="w-12 text-right text-xs text-fg-2">{`${n.exits} ${n.exits === 1 ? 'exit' : 'exits'}`}</span>
                    </div>
                  ))}
                </div>
              )}
        </Card>
      </div>
    </div>
  )
}

function Calendar({ month, byKey, loading }: { month: Date, byKey: Map<string, MonthNight>, loading: boolean }) {
  const todayKey = dayKey(new Date())
  return (
    <div className="grid grid-cols-7 gap-1.5">
      {WEEKDAYS.map((d, i) => (
        <div key={i} className="pb-1 text-center font-mono text-[10px] text-fg-3">{d}</div>
      ))}
      {monthCells(month).map((day, i) => {
        if (!day) return <div key={`blank-${i}`} />
        const key = dayKey(day)
        const night = byKey.get(key)
        const future = key > todayKey
        const isToday = key === todayKey
        return (
          <div
            key={key}
            data-testid={`day-${key}`}
            className={cn(
              'flex h-11 min-w-0 flex-col justify-between rounded-thumb border px-1 py-1 min-[900px]:h-[58px] min-[900px]:px-2 min-[900px]:py-[7px]',
              night || future || isToday || loading ? 'border-transparent' : 'border-dashed border-line-2',
              isToday && 'shadow-[inset_0_0_0_1px_var(--text-1)]',
              loading && 'animate-pulse bg-active',
            )}
            style={night ? { background: `rgba(var(--heat-rgb), ${heatAlpha(night.hours)})` } : undefined}
          >
            <span className={cn('font-mono text-[10px]', future ? 'text-fg-3' : 'text-fg-2')}>{day.getDate()}</span>
            {night
              ? (
                  <span className="font-mono text-xs min-[900px]:text-[13px]">
                    <span className="min-[900px]:hidden">{night.hours.toFixed(1)}</span>
                    <span className="max-[899px]:hidden">{formatDuration(night.hours * 3600)}</span>
                  </span>
                )
              : !future && !isToday && !loading && <span className="overflow-hidden whitespace-nowrap text-[9px] text-fg-3 min-[900px]:text-[10px]">no data</span>}
          </div>
        )
      })}
    </div>
  )
}
