'use client'

import { useMemo } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import { useSchedule } from '@/src/hooks/useSchedule'
import { timeStringToMinutes } from '@/src/lib/sleepCurve/generate'
import type { CurvePoint, Phase } from '@/src/lib/sleepCurve/types'
import { DAYS, type DayOfWeek } from './DaySelector'
import { CurvePresets } from './CurvePresets'
import { CurveChart } from './CurveChart'
import { PhaseLegend } from './PhaseLegend'
import { TemperatureSetPoints } from './TemperatureSetPoints'
import { PowerScheduleSection } from './PowerScheduleSection'
import { AlarmScheduleSection } from './AlarmScheduleSection'
import { ApplyToOtherDays } from './ApplyToOtherDays'
import { SchedulerConfirmation } from './SchedulerConfirmation'

interface ScheduleDayDetailProps {
  day: string
}

export function ScheduleDayDetail({ day }: ScheduleDayDetailProps) {
  const router = useRouter()
  const { side } = useSide()

  const validDay = DAYS.find(d => d.key === day)
  const dayOfWeek = validDay?.key as DayOfWeek

  const { data, isLoading } = trpc.schedules.getByDay.useQuery(
    { side, dayOfWeek },
    { enabled: !!validDay },
  )

  const utils = trpc.useUtils()

  const {
    selectedDays,
    applyToOtherDays,
    hasScheduleData,
    isApplying,
    confirmMessage,
  } = useSchedule()

  // Derive CurvePoint[] from temperature schedule data
  const { curvePoints, bedtimeMinutes, minTempF, maxTempF } = useMemo(() => {
    const temps = data?.temperature ?? []
    const power = data?.power?.[0]
    const bedtime = power?.onTime ?? '22:00'
    const btMin = timeStringToMinutes(bedtime)

    if (temps.length === 0) {
      return { curvePoints: [] as CurvePoint[], bedtimeMinutes: btMin, minTempF: 68, maxTempF: 86 }
    }

    const sorted = [...temps]
      .map((t) => {
        let mfb = timeStringToMinutes(t.time) - btMin
        if (mfb < -120) mfb += 24 * 60
        return { ...t, minutesFromBedtime: mfb }
      })
      .sort((a, b) => a.minutesFromBedtime - b.minutesFromBedtime)

    const tempValues = sorted.map(t => t.temperature)
    const min = Math.min(...tempValues)
    const max = Math.max(...tempValues)
    const total = sorted.length

    const points: CurvePoint[] = sorted.map((t, i) => {
      const frac = total > 1 ? i / (total - 1) : 0
      const phase: Phase = frac < 0.1
        ? 'warmUp'
        : frac < 0.25
          ? 'coolDown'
          : frac < 0.55
            ? 'deepSleep'
            : frac < 0.75
              ? 'maintain'
              : frac < 0.9
                ? 'preWake'
                : 'wake'

      return {
        minutesFromBedtime: t.minutesFromBedtime,
        tempOffset: t.temperature - 80,
        phase,
      }
    })

    return { curvePoints: points, bedtimeMinutes: btMin, minTempF: min, maxTempF: max }
  }, [data])

  if (!validDay) {
    return (
      <div className="py-12 text-center text-sm text-zinc-500">
        Invalid day.
        {' '}
        <button onClick={() => router.back()} className="text-sky-400 underline">Go back</button>
      </div>
    )
  }

  const dayLabel = DAYS.find(d => d.key === day)?.label ?? day

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => router.back()}
          className="flex items-center gap-1.5 text-sm text-sky-400 transition-colors active:text-sky-300"
        >
          <ArrowLeft size={16} />
          Schedule
        </button>
      </div>

      <h1 className="text-lg font-semibold text-white">{dayLabel}</h1>

      {/* Curve Presets */}
      <CurvePresets
        side={side}
        selectedDay={dayOfWeek}
        selectedDays={new Set([dayOfWeek])}
        onApplied={() => void utils.schedules.invalidate()}
        onAICurveApplied={() => void utils.schedules.invalidate()}
      />

      {/* Curve Chart */}
      {curvePoints.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
          <CurveChart
            points={curvePoints}
            bedtimeMinutes={bedtimeMinutes}
            minTempF={minTempF}
            maxTempF={maxTempF}
          />
          <div className="mt-2">
            <PhaseLegend />
          </div>
        </div>
      )}

      {/* Temperature Set Points */}
      <TemperatureSetPoints selectedDay={dayOfWeek} />

      {/* Power Schedule */}
      <PowerScheduleSection
        schedules={data?.power ?? []}
        selectedDay={dayOfWeek}
        isLoading={isLoading}
      />

      {/* Alarm Schedule */}
      <AlarmScheduleSection
        schedules={data?.alarm ?? []}
        selectedDay={dayOfWeek}
        isLoading={isLoading}
      />

      {/* Apply to Other Days */}
      <ApplyToOtherDays
        sourceDay={dayOfWeek}
        selectedDays={selectedDays}
        onApply={targetDays => void applyToOtherDays(targetDays)}
        isLoading={isApplying}
        hasSchedule={hasScheduleData}
      />

      {/* Confirmation */}
      <SchedulerConfirmation
        message={confirmMessage}
        isLoading={isApplying}
        variant={confirmMessage?.includes('Failed') ? 'error' : 'success'}
      />
    </div>
  )
}
