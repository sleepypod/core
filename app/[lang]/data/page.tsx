'use client'

import { useRef, useCallback } from 'react'
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react'
import { useSide } from '@/src/providers/SideProvider'
import { useWeekNavigator } from '@/src/hooks/useWeekNavigator'
import { trpc } from '@/src/utils/trpc'

// Sub-components
import { SleepStagesCard } from '@/src/components/SleepStages/SleepStagesCard'
import { VitalsPanel } from '@/src/components/VitalsPanel/VitalsPanel'
import { MovementChart } from '@/src/components/MovementChart/MovementChart'
import { SleepSummaryCard } from '@/src/components/biometrics/SleepSummaryCard'
import { VitalsGrid } from '@/src/components/biometrics/VitalsGrid'
import { RawDataButton } from '@/src/components/biometrics/RawDataButton'

// Section IDs for scroll navigation
const SECTIONS = [
  { id: 'sleep', label: 'Sleep' },
  { id: 'stages', label: 'Stages' },
  { id: 'vitals', label: 'Vitals' },
  { id: 'movement', label: 'Movement' },
] as const

/**
 * Biometrics page — unified scrollable view matching iOS HealthScreen.
 *
 * Layout: date picker + L/R toggle → section pills →
 *   Sleep Summary → Stages → VitalsGrid (3-block) → Vitals charts →
 *   Sleep Sessions → Movement → Raw Data
 */
export default function DataPage() {
  const { selectedSide, activeSides, primarySide, selectSide } = useSide()
  const week = useWeekNavigator()
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const showBothSides = selectedSide === 'both'

  const handleSideToggle = useCallback(() => {
    selectSide(primarySide === 'left' ? 'right' : 'left')
  }, [primarySide, selectSide])

  // Fetch sleep records for each active side
  const leftSleepQuery = trpc.biometrics.getSleepRecords.useQuery(
    {
      side: 'left',
      startDate: week.weekStart,
      endDate: week.weekEnd,
      limit: 7,
    },
    { enabled: activeSides.includes('left') },
  )

  const rightSleepQuery = trpc.biometrics.getSleepRecords.useQuery(
    {
      side: 'right',
      startDate: week.weekStart,
      endDate: week.weekEnd,
      limit: 7,
    },
    { enabled: activeSides.includes('right') },
  )

  const leftRecords = ((leftSleepQuery.data ?? []) as SleepRecordRow[]).map(
    r => ({ ...r, side: 'left' as const }),
  )
  const rightRecords = ((rightSleepQuery.data ?? []) as SleepRecordRow[]).map(
    r => ({ ...r, side: 'right' as const }),
  )

  const allSleepRecords = [
    ...(activeSides.includes('left') ? leftRecords : []),
    ...(activeSides.includes('right') ? rightRecords : []),
  ].sort(
    (a, b) => new Date(b.enteredBedAt).getTime() - new Date(a.enteredBedAt).getTime(),
  )

  const scrollToSection = useCallback((sectionId: string) => {
    const el = document.getElementById(`section-${sectionId}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [])

  return (
    <div ref={scrollContainerRef} className="space-y-4 sm:space-y-5">
      {/* ── Header: Date Picker + Side Toggle ── */}
      <div className="flex items-center gap-2">
        <button
          onClick={week.goToPreviousWeek}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-800/80 text-zinc-400 active:bg-zinc-700"
          aria-label="Previous week"
        >
          <ChevronLeft size={16} />
        </button>

        <button
          onClick={week.goToCurrentWeek}
          className="flex min-h-[36px] flex-1 items-center justify-center gap-1.5 rounded-xl bg-zinc-800/80 px-2 py-1.5 active:bg-zinc-700"
          aria-label="Go to current week"
        >
          <Calendar size={13} className="text-sky-400" />
          <span className="text-[12px] font-medium text-white sm:text-[13px]">{week.label}</span>
        </button>

        <button
          onClick={week.goToNextWeek}
          disabled={week.isCurrentWeek}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-800/80 text-zinc-400 active:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Next week"
        >
          <ChevronRight size={16} />
        </button>

        {/* Side toggle — tap to swap L ↔ R */}
        <button
          onClick={handleSideToggle}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-zinc-800/80 px-3 active:bg-zinc-700"
          aria-label={`Showing ${primarySide} side, tap to switch`}
        >
          <span
            className={`flex h-5 w-5 items-center justify-center rounded-md text-[11px] font-bold ${
              primarySide === 'left'
                ? 'bg-sky-500/20 text-sky-400'
                : 'bg-teal-500/20 text-teal-400'
            }`}
          >
            {primarySide === 'left' ? 'L' : 'R'}
          </span>
          <span className="text-[11px] font-medium text-zinc-400">
            {primarySide === 'left' ? 'Left' : 'Right'}
          </span>
        </button>
      </div>

      {/* Section Navigation Pills */}
      <div className="no-scrollbar -mx-3 flex gap-1.5 overflow-x-auto px-3 sm:-mx-4 sm:gap-2 sm:px-4">
        {SECTIONS.map(section => (
          <button
            key={section.id}
            onClick={() => scrollToSection(section.id)}
            className="whitespace-nowrap rounded-full bg-zinc-900 px-3 py-1.5 text-[11px] font-medium text-zinc-400 active:bg-zinc-800 active:text-white"
          >
            {section.label}
          </button>
        ))}
      </div>

      {/* ── Sleep Summary ── */}
      <section id="section-sleep">
        {showBothSides ? (
          <div className="space-y-3">
            <SideLabel side="left" />
            <SleepSummaryCard records={allSleepRecords.filter(r => r.side === 'left')} />
            <SideLabel side="right" />
            <SleepSummaryCard records={allSleepRecords.filter(r => r.side === 'right')} />
          </div>
        ) : (
          <SleepSummaryCard records={allSleepRecords} />
        )}
      </section>

      {/* ── Sleep Stages ── */}
      <section id="section-stages">
        {showBothSides ? (
          <div className="space-y-4">
            <SideLabel side="left" />
            <SleepStagesCard side="left" />
            <SideLabel side="right" />
            <SleepStagesCard side="right" />
          </div>
        ) : (
          <SleepStagesCard side={primarySide} />
        )}
      </section>

      {/* ── Vitals: 3-block grid + charts (no duplicate nav/summary) ── */}
      <section id="section-vitals" className="space-y-4">
        <VitalsGrid />
        <VitalsPanel dualSide={showBothSides} hideNav hideSummary />
      </section>

      {/* ── Movement (no duplicate date picker) ── */}
      <section id="section-movement">
        <MovementChart dualSide={showBothSides} hideNav />
      </section>

      {/* ── Raw Data Export ── */}
      <RawDataButton />
    </div>
  )
}

// ── Helper types & components ──

interface SleepRecordRow {
  id: number
  side: 'left' | 'right'
  enteredBedAt: Date
  leftBedAt: Date
  sleepDurationSeconds: number
  timesExitedBed: number
}

function SideLabel({ side }: { side: 'left' | 'right' }) {
  const isLeft = side === 'left'
  return (
    <div className="flex items-center gap-2">
      <div className={`h-2 w-2 rounded-full ${isLeft ? 'bg-sky-400' : 'bg-teal-400'}`} />
      <span className={`text-xs font-semibold capitalize ${isLeft ? 'text-sky-400' : 'text-teal-400'}`}>
        {side} Side
      </span>
    </div>
  )
}
