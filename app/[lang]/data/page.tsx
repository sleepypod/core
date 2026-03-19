'use client'

import { useRef, useCallback } from 'react'
import { useSide } from '@/src/providers/SideProvider'
import { useWeekNavigator } from '@/src/hooks/useWeekNavigator'
import { trpc } from '@/src/utils/trpc'

// Shared navigation components
import { WeekNavigator } from '@/src/components/WeekNavigator/WeekNavigator'

// Sub-components from prior ACs
import { SleepStagesCard } from '@/src/components/SleepStages'
import { VitalsPanel } from '@/src/components/VitalsPanel/VitalsPanel'
import { MovementChart } from '@/src/components/MovementChart/MovementChart'
import { EnvironmentPanel } from '@/src/components/Environment'

// Biometrics composition components
import { SleepSummaryCard } from '@/src/components/biometrics/SleepSummaryCard'
import { VitalsGrid } from '@/src/components/biometrics/VitalsGrid'
import { RawDataButton } from '@/src/components/biometrics/RawDataButton'
import { DataSideFilter } from '@/src/components/biometrics/DataSideFilter'

// Section IDs for scroll navigation
const SECTIONS = [
  { id: 'sleep', label: 'Sleep' },
  { id: 'stages', label: 'Stages' },
  { id: 'vitals', label: 'Vitals' },
  { id: 'environment', label: 'Environment' },
  { id: 'movement', label: 'Movement' },
] as const

/**
 * Data/Biometrics page — unified scrollable view matching iOS HealthScreen.
 *
 * The DataSideFilter in the header controls which series appear in all chart views:
 * - "Both": dual-series comparison mode (left & right data shown side-by-side)
 * - "Left" / "Right": single-side mode
 *
 * All components share side context via the global SideProvider which supports
 * 'both' | 'left' | 'right' selection persisted to localStorage.
 */
export default function DataPage() {
  const { selectedSide, activeSides, primarySide } = useSide()
  const week = useWeekNavigator()
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const showBothSides = selectedSide === 'both'

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

  // Combine sleep records based on active sides, sorted most recent first
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

  // Scroll to section
  const scrollToSection = useCallback((sectionId: string) => {
    const el = document.getElementById(`section-${sectionId}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [])

  return (
    <div ref={scrollContainerRef} className="space-y-4 sm:space-y-5">
      {/* ── Navigation Header ── */}

      {/* Week Navigator */}
      <WeekNavigator
        label={week.label}
        isCurrentWeek={week.isCurrentWeek}
        onPrevious={week.goToPreviousWeek}
        onNext={week.goToNextWeek}
        onToday={week.goToCurrentWeek}
      />

      {/* Side Filter Toggle (Both / Left / Right) */}
      <DataSideFilter />

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

      {/* ── Section 1: Sleep Summary ── */}
      <section id="section-sleep">
        {showBothSides ? (
          <div className="space-y-3">
            <SideLabel side="left" />
            <SleepSummaryCard
              records={allSleepRecords.filter(r => r.side === 'left')}
            />
            <SideLabel side="right" />
            <SleepSummaryCard
              records={allSleepRecords.filter(r => r.side === 'right')}
            />
          </div>
        ) : (
          <SleepSummaryCard records={allSleepRecords} />
        )}
      </section>

      {/* ── Section 2: Sleep Stages ── */}
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

      {/* ── Section 3: Vitals ── */}
      <section id="section-vitals" className="space-y-4">
        {/* Quick summary grid — uses primarySide internally via useSide hook */}
        <VitalsGrid />

        {/* Detailed vitals charts (HR, HRV, Breathing Rate) — dual-side overlay when "Both" */}
        <VitalsPanel dualSide={showBothSides} />
      </section>

      {/* ── Section 4: Environment ── */}
      <section id="section-environment">
        <EnvironmentPanel dualSide={showBothSides} />
      </section>

      {/* ── Section 5: Movement ── */}
      <section id="section-movement">
        <MovementChart dualSide={showBothSides} />
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

/**
 * Colored label to distinguish left vs right side in dual-side comparison mode.
 */
function SideLabel({ side }: { side: 'left' | 'right' }) {
  const isLeft = side === 'left'
  return (
    <div className="flex items-center gap-2">
      <div
        className={`h-2 w-2 rounded-full ${
          isLeft ? 'bg-sky-400' : 'bg-teal-400'
        }`}
      />
      <span
        className={`text-xs font-semibold capitalize ${
          isLeft ? 'text-sky-400' : 'text-teal-400'
        }`}
      >
        {side} Side
      </span>
    </div>
  )
}
