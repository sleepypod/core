'use client'

import { useCallback, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { PageHeader, SegmentedControl } from '@/src/components/ds'
import { useBiometricsSide } from '@/src/hooks/useBiometricsSide'
import { useSideNames } from '@/src/hooks/useSideNames'
import { useWeekNavigator } from '@/src/hooks/useWeekNavigator'
import { cn } from '@/lib/utils'
import { RawDataButton } from '@/src/components/biometrics/RawDataButton'
import { NightView } from './NightView'
import { WeekView } from './WeekView'
import { MonthView } from './MonthView'
import { formatRange, monthStart, type Side, type SleepView } from './sleepData'

const VIEWS = [
  { value: 'night', label: 'Night' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
] as const

/**
 * Sleep (was Biometrics): one person at a time, a shared week navigator,
 * and a Night | Week | Month switch that drives every card.
 */
export function SleepScreen({ sectionSwitch }: { sectionSwitch?: ReactNode } = {}) {
  // One side only for a single sleeper (the other is away) — no person switch.
  const { side, toggleSide } = useBiometricsSide()
  const { leftName, rightName } = useSideNames()
  const week = useWeekNavigator()
  const [view, setView] = useState<SleepView>('night')
  // Night picked from a week bar; null = latest night of the week.
  const [nightKey, setNightKey] = useState<string | null>(null)
  const [month, setMonth] = useState(() => monthStart(new Date()))
  const isCurrentMonth = month.getTime() === monthStart(new Date()).getTime()

  const selectSide = useCallback((next: Side) => {
    if (next !== side) toggleSide?.()
    setNightKey(null)
  }, [side, toggleSide])

  const shiftMonth = (delta: number) => setMonth(m => new Date(m.getFullYear(), m.getMonth() + delta, 1))

  const nav = view === 'month'
    ? {
        label: month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
        prev: () => shiftMonth(-1),
        next: () => shiftMonth(1),
        canNext: !isCurrentMonth,
        unit: 'month',
      }
    : {
        label: formatRange(week.weekStart, week.weekEnd),
        prev: () => {
          week.goToPreviousWeek()
          setNightKey(null)
        },
        next: () => {
          week.goToNextWeek()
          setNightKey(null)
        },
        canNext: !week.isCurrentWeek,
        unit: 'week',
      }

  const personControl = toggleSide && (
    <SegmentedControl
      ariaLabel="Person"
      options={[{ value: 'left', label: leftName }, { value: 'right', label: rightName }]}
      value={side}
      onChange={selectSide}
      size="md"
    />
  )

  const navigator = (className?: string) => (
    <div className={cn('flex items-center gap-3 font-mono text-[13px]', className)}>
      <button
        type="button"
        aria-label={`Previous ${nav.unit}`}
        onClick={nav.prev}
        className="flex cursor-pointer items-center border-0 bg-transparent p-0 text-fg-2 hover:text-fg"
      >
        <ChevronLeft size={16} />
      </button>
      <span className="whitespace-nowrap">{nav.label}</span>
      <button
        type="button"
        aria-label={`Next ${nav.unit}`}
        onClick={nav.next}
        disabled={!nav.canNext}
        className="flex cursor-pointer items-center border-0 bg-transparent p-0 text-fg-2 hover:text-fg disabled:cursor-default disabled:text-fg-3"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  )

  const viewControl = (full: boolean) => (
    <SegmentedControl ariaLabel="Range" options={VIEWS} value={view} onChange={setView} full={full} />
  )

  return (
    <>
      {sectionSwitch && <span className="-mb-2 hidden font-mono text-[13px] text-fg-2 min-[900px]:block">Sleep /</span>}
      <PageHeader
        title={sectionSwitch
          ? (
              <>
                <span className="min-[900px]:hidden">Sleep</span>
                <span className="hidden min-[900px]:inline">Nights</span>
              </>
            )
          : 'Sleep'}
        middle={(
          <>
            {personControl && <div className="ml-auto min-[900px]:ml-0">{personControl}</div>}
            <div className="ml-auto hidden items-center gap-4 min-[900px]:flex">
              {navigator()}
              {viewControl(false)}
            </div>
          </>
        )}
      />
      <div className="flex flex-col gap-3.5 min-[900px]:hidden">
        {sectionSwitch}
        {viewControl(true)}
        {navigator('justify-between [&_svg]:size-[18px]')}
      </div>

      {view === 'night' && <NightView side={side} weekStart={week.weekStart} isCurrentWeek={week.isCurrentWeek} nightKey={nightKey} onSelectNight={setNightKey} />}
      {view === 'week' && <WeekView side={side} weekStart={week.weekStart} nightKey={nightKey} onSelectNight={setNightKey} />}
      {view === 'month' && <MonthView side={side} month={month} />}

      <RawDataButton />
    </>
  )
}
