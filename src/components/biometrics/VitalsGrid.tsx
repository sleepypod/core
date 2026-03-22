'use client'

import { Activity, Heart, Wind } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import { useWeekNavigator } from '@/src/hooks/useWeekNavigator'

/**
 * 3-column vitals summary grid matching iOS HealthMetricsGridView.
 * Self-contained: fetches summary from tRPC for the shared week/side context.
 */
export function VitalsGrid() {
  const { side } = useSide()
  const { weekStart, weekEnd } = useWeekNavigator()

  const summaryQuery = trpc.biometrics.getVitalsSummary.useQuery({
    side,
    startDate: weekStart,
    endDate: weekEnd,
  })

  const summary = summaryQuery.data

  const metrics = [
    {
      icon: Heart,
      label: 'Avg HR',
      value: summary?.avgHeartRate != null ? Math.round(summary.avgHeartRate) : '–',
      unit: 'bpm',
      color: 'text-red-400',
    },
    {
      icon: Activity,
      label: 'HRV',
      value: summary?.avgHRV != null ? Math.round(summary.avgHRV) : '–',
      unit: 'ms',
      color: 'text-purple-400',
    },
    {
      icon: Wind,
      label: 'Breathing',
      value: summary?.avgBreathingRate != null ? Math.round(summary.avgBreathingRate) : '–',
      unit: 'br/min',
      color: 'text-cyan-400',
    },
  ]

  return (
    <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
      {metrics.map(({ icon: Icon, label, value, unit, color }) => (
        <div key={label} className="rounded-xl bg-zinc-900/80 p-2 text-center sm:p-3">
          <Icon size={14} className={`mx-auto mb-1 sm:mb-1.5 ${color}`} />
          <p className="text-base font-semibold tabular-nums text-zinc-100 sm:text-lg">{value}</p>
          <p className="text-[9px] text-zinc-500 sm:text-[10px]">{unit}</p>
          <p className="mt-0.5 text-[9px] text-zinc-600 sm:text-[10px]">{label}</p>
        </div>
      ))}
    </div>
  )
}
