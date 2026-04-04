'use client'

import { useMemo, useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import type { DayOfWeek } from './DaySelector'
import { DAYS } from './DaySelector'
import { CurveChart } from './CurveChart'
import { timeStringToMinutes } from '@/src/lib/sleepCurve/generate'
import type { CurvePoint, Phase } from '@/src/lib/sleepCurve/types'
import { Calendar, Pencil } from 'lucide-react'
import { useRouter, usePathname } from 'next/navigation'
import clsx from 'clsx'

const GROUP_COLORS = [
  'bg-sky-500',
  'bg-amber-500',
  'bg-emerald-500',
  'bg-purple-500',
  'bg-rose-500',
]

interface ScheduleGroup {
  id: number
  name: string
  side: string
  days: string[]
}

interface ScheduleWeekOverviewProps {
  onGroupDaysChange: (days: Set<DayOfWeek>) => void
}

function formatDayLabels(days: string[]): string {
  const ordered = DAYS.map(d => d.key).filter(k => days.includes(k))
  if (ordered.length === 0) return ''

  const labels = ordered.map((k) => {
    const d = DAYS.find(d => d.key === k)
    return d?.label ?? k
  })

  // Check for contiguous ranges
  const indices = ordered.map(k => DAYS.findIndex(d => d.key === k))
  let isContiguous = true
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== indices[i - 1] + 1) {
      isContiguous = false
      break
    }
  }

  if (isContiguous && labels.length > 2) {
    return `${labels[0]}\u2013${labels[labels.length - 1]}`
  }
  return labels.join(', ')
}

export function ScheduleWeekOverview({
  onGroupDaysChange,
}: ScheduleWeekOverviewProps) {
  const { side } = useSide()
  const router = useRouter()
  const pathname = usePathname()
  const lang = pathname.split('/')[1] || 'en'

  const { data: groups, isLoading: groupsLoading } = trpc.scheduleGroups.getAll.useQuery({ side })
  const { data: scheduleData, isLoading: schedulesLoading } = trpc.schedules.getAll.useQuery({ side })

  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null)

  const isLoading = groupsLoading || schedulesLoading

  // Get temperature range for a group's days
  const getGroupTempRange = (days: string[]) => {
    if (!scheduleData) return null
    const temps = (scheduleData.temperature ?? []).filter(
      (t: { dayOfWeek: string, temperature: number }) => days.includes(t.dayOfWeek)
    )
    if (temps.length === 0) return null
    const values = temps.map((t: { temperature: number }) => t.temperature)
    return { min: Math.min(...values), max: Math.max(...values) }
  }

  // Derive curve points for the selected group
  const curveData = useMemo(() => {
    if (!selectedGroupId || !scheduleData || !groups) return null

    const group = (groups as ScheduleGroup[]).find(g => g.id === selectedGroupId)
    if (!group || group.days.length === 0) return null

    const firstDay = group.days[0]
    const temps = (scheduleData.temperature ?? []).filter(
      (t: { dayOfWeek: string }) => t.dayOfWeek === firstDay
    )
    const power = (scheduleData.power ?? []).find(
      (p: { dayOfWeek: string }) => p.dayOfWeek === firstDay
    )
    const bedtime = power?.onTime ?? '22:00'
    const btMin = timeStringToMinutes(bedtime)

    if (temps.length === 0) return null

    const sorted = [...temps]
      .map((t: { time: string, temperature: number }) => {
        let mfb = timeStringToMinutes(t.time) - btMin
        if (mfb < -120) mfb += 24 * 60
        return { ...t, minutesFromBedtime: mfb }
      })
      .sort((a: { minutesFromBedtime: number }, b: { minutesFromBedtime: number }) => a.minutesFromBedtime - b.minutesFromBedtime)

    const tempValues = sorted.map((t: { temperature: number }) => t.temperature)
    const min = Math.min(...tempValues)
    const max = Math.max(...tempValues)
    const total = sorted.length

    const points: CurvePoint[] = sorted.map((t: { minutesFromBedtime: number, temperature: number }, i: number) => {
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
  }, [selectedGroupId, scheduleData, groups])

  if (isLoading) {
    return (
      <div className="h-16 animate-pulse rounded-2xl bg-zinc-900" />
    )
  }

  const typedGroups = (groups ?? []) as ScheduleGroup[]

  if (typedGroups.length === 0) {
    return (
      <div className="rounded-2xl bg-zinc-900 p-4">
        <div className="flex items-center gap-2">
          <Calendar size={16} className="text-zinc-500" />
          <h3 className="text-sm font-medium text-zinc-400">Schedule Groups</h3>
        </div>
        <p className="mt-2 text-xs text-zinc-500">No schedule groups configured.</p>
      </div>
    )
  }

  const handleGroupTap = (group: ScheduleGroup) => {
    const days = new Set(group.days as DayOfWeek[])
    if (selectedGroupId === group.id) {
      // Deselect
      setSelectedGroupId(null)
      onGroupDaysChange(new Set())
    }
    else {
      setSelectedGroupId(group.id)
      onGroupDaysChange(days)
    }
  }

  const handleEdit = (group: ScheduleGroup) => {
    const firstDay = group.days[0]
    if (firstDay) {
      router.push(`/${lang}/schedule/${firstDay}`)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Calendar size={16} className="text-zinc-500" />
        <h3 className="text-sm font-medium text-zinc-400">Schedule Groups</h3>
      </div>

      <div className="space-y-2">
        {typedGroups.map((group, i) => {
          const isSelected = selectedGroupId === group.id
          const tempRange = getGroupTempRange(group.days)
          const color = GROUP_COLORS[i % GROUP_COLORS.length]

          return (
            <button
              key={group.id}
              type="button"
              onClick={() => handleGroupTap(group)}
              className={clsx(
                'flex w-full items-center justify-between rounded-2xl p-3 text-left transition-colors sm:p-4',
                isSelected
                  ? 'bg-zinc-800 ring-1 ring-sky-500/40'
                  : 'bg-zinc-900 active:bg-zinc-800',
              )}
            >
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <div className={clsx('h-2.5 w-2.5 rounded-full', color)} />
                  <span className="text-sm font-medium text-white">{group.name}</span>
                </div>
                <div className="mt-1 flex items-center gap-3">
                  <span className="text-xs text-zinc-500">
                    {formatDayLabels(group.days)}
                  </span>
                  {tempRange && (
                    <span className="text-xs text-zinc-400">
                      {`${tempRange.min}–${tempRange.max}°F`}
                    </span>
                  )}
                </div>
              </div>
              {isSelected && (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleEdit(group)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation()
                      handleEdit(group)
                    }
                  }}
                  className="flex items-center gap-1 rounded-lg bg-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-600"
                >
                  <Pencil size={12} />
                  Edit
                </div>
              )}
            </button>
          )
        })}
      </div>

      {curveData && curveData.curvePoints.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
          <CurveChart
            points={curveData.curvePoints}
            bedtimeMinutes={curveData.bedtimeMinutes}
            minTempF={curveData.minTempF}
            maxTempF={curveData.maxTempF}
          />
        </div>
      )}
    </div>
  )
}
