'use client'

import { useCallback, useMemo, useState } from 'react'
import { Moon, Sun, Loader2, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { trpc } from '@/src/utils/trpc'
import {
  generateSleepCurve,
  curveToScheduleTemperatures,
  timeStringToMinutes,
} from '@/src/lib/sleepCurve/generate'
import type { CoolingIntensity, CurvePoint } from '@/src/lib/sleepCurve/types'
import type { DayOfWeek } from './DaySelector'

type Side = 'left' | 'right'

interface PresetDef {
  id: CoolingIntensity
  label: string
  subtitle: string
  icon: string
  bedtime: string
  wakeTime: string
  minTempF: number
  maxTempF: number
  accentActive: string
  accentBorder: string
}

const PRESETS: PresetDef[] = [
  {
    id: 'cool',
    label: 'Hot Sleeper',
    subtitle: 'Extra cool through the night',
    icon: '❄️',
    bedtime: '22:00',
    wakeTime: '06:30',
    minTempF: 65,
    maxTempF: 84,
    accentActive: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
    accentBorder: 'border-blue-500/50',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    subtitle: 'Science-backed defaults',
    icon: '⚖️',
    bedtime: '22:00',
    wakeTime: '07:00',
    minTempF: 68,
    maxTempF: 86,
    accentActive: 'bg-violet-500/10 text-violet-400 border-violet-500/30',
    accentBorder: 'border-violet-500/50',
  },
  {
    id: 'warm',
    label: 'Cold Sleeper',
    subtitle: 'Gentler cooling, warmer wake',
    icon: '🔥',
    bedtime: '22:30',
    wakeTime: '07:00',
    minTempF: 72,
    maxTempF: 88,
    accentActive: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
    accentBorder: 'border-orange-500/50',
  },
]

interface CurvePresetsProps {
  side: Side
  selectedDay: DayOfWeek
  selectedDays: Set<DayOfWeek>
  /** Called after applying a preset, with the generated curve + config for chart display */
  onApplied?: (config: {
    points: CurvePoint[]
    bedtimeMinutes: number
    minTempF: number
    maxTempF: number
    intensity: CoolingIntensity
    bedtime: string
    wakeTime: string
  }) => void
}

/**
 * Horizontal scroll of sleep preset cards.
 * Tapping a preset generates a curve and writes it to the schedule for the selected days.
 */
export function CurvePresets({ side, selectedDay, selectedDays, onApplied }: CurvePresetsProps) {
  const [applying, setApplying] = useState<CoolingIntensity | null>(null)
  const [applied, setApplied] = useState<CoolingIntensity | null>(null)

  const utils = trpc.useUtils()
  const createTempSchedule = trpc.schedules.createTemperatureSchedule.useMutation()
  const deleteTempSchedule = trpc.schedules.deleteTemperatureSchedule.useMutation()
  const createPowerSchedule = trpc.schedules.createPowerSchedule.useMutation()
  const deletePowerSchedule = trpc.schedules.deletePowerSchedule.useMutation()

  const handleApply = useCallback(async (preset: PresetDef) => {
    setApplying(preset.id)
    try {
      const bedtimeMinutes = timeStringToMinutes(preset.bedtime)
      const wakeMinutes = timeStringToMinutes(preset.wakeTime)
      const curvePoints = generateSleepCurve({
        bedtimeMinutes,
        wakeMinutes,
        intensity: preset.id,
        minTempF: preset.minTempF,
        maxTempF: preset.maxTempF,
      })
      const scheduleTemps = curveToScheduleTemperatures(curvePoints, bedtimeMinutes)

      const daysToApply = Array.from(selectedDays)

      for (const day of daysToApply) {
        // Fetch existing schedules for this day to clear them
        const existing = await utils.schedules.getByDay.fetch({ side, dayOfWeek: day })

        // Delete existing temperature + power schedules
        await Promise.all([
          ...existing.temperature.map((s: { id: number }) =>
            deleteTempSchedule.mutateAsync({ id: s.id }),
          ),
          ...existing.power.map((s: { id: number }) =>
            deletePowerSchedule.mutateAsync({ id: s.id }),
          ),
        ])

        // Create new temperature schedule entries + power schedule
        await Promise.all([
          ...Object.entries(scheduleTemps).map(([time, temperature]) =>
            createTempSchedule.mutateAsync({
              side,
              dayOfWeek: day,
              time,
              temperature: Math.max(55, Math.min(110, temperature)),
              enabled: true,
            }),
          ),
          createPowerSchedule.mutateAsync({
            side,
            dayOfWeek: day,
            onTime: preset.bedtime,
            offTime: preset.wakeTime,
            onTemperature: Math.max(55, Math.min(110, 80 + curvePoints[0].tempOffset)),
            enabled: true,
          }) as Promise<unknown>,
        ])
      }

      await utils.schedules.invalidate()

      onApplied?.({
        points: curvePoints,
        bedtimeMinutes,
        minTempF: preset.minTempF,
        maxTempF: preset.maxTempF,
        intensity: preset.id,
        bedtime: preset.bedtime,
        wakeTime: preset.wakeTime,
      })

      setApplied(preset.id)
      setTimeout(() => setApplied(null), 2000)
    } catch (err) {
      console.error('Failed to apply preset:', err)
    } finally {
      setApplying(null)
    }
  }, [
    selectedDays,
    side,
    utils,
    createTempSchedule,
    deleteTempSchedule,
    createPowerSchedule,
    deletePowerSchedule,
    onApplied,
  ])

  return (
    <div className="space-y-2">
      <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">
        Sleep Profiles
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-none">
        {PRESETS.map(preset => {
          const isApplying = applying === preset.id
          const isApplied = applied === preset.id

          return (
            <button
              key={preset.id}
              type="button"
              disabled={applying !== null}
              onClick={() => void handleApply(preset)}
              className={cn(
                'flex min-w-[140px] flex-col items-center gap-1.5 rounded-xl border px-4 py-3 text-center transition-all duration-200 shrink-0',
                isApplied
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                  : isApplying
                    ? preset.accentActive
                    : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 active:scale-[0.97]',
                applying !== null && !isApplying && 'opacity-50',
              )}
            >
              {isApplying ? (
                <Loader2 size={20} className="animate-spin" />
              ) : isApplied ? (
                <Check size={20} />
              ) : (
                <span className="text-xl">{preset.icon}</span>
              )}
              <span className="text-xs font-semibold">{preset.label}</span>
              <span className="text-[10px] leading-tight opacity-70">{preset.subtitle}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
