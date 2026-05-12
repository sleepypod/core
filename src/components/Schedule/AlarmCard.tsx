'use client'

import { Bell, Pencil, Play, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import type { DayOfWeek } from './DaySelector'
import { formatTime12h } from './TimeInput'

export interface AlarmGroup {
  /** All underlying alarm_schedules row ids in this group */
  ids: number[]
  days: DayOfWeek[]
  time: string
  vibrationIntensity: number
  vibrationPattern: 'rise' | 'double'
  duration: number
  alarmTemperature: number
  enabled: boolean
}

interface AlarmCardProps {
  group: AlarmGroup
  onEdit: () => void
  onDelete: () => void
  onTest: () => void
  isTesting?: boolean
}

const DAY_SHORT: Record<DayOfWeek, string> = {
  sunday: 'Sun', monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed',
  thursday: 'Thu', friday: 'Fri', saturday: 'Sat',
}

const DAY_ORDER: DayOfWeek[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const WEEKDAYS: DayOfWeek[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
const WEEKENDS: DayOfWeek[] = ['saturday', 'sunday']

function formatDayRange(days: DayOfWeek[]): string {
  if (days.length === 0) return ''
  if (days.length === 7) return 'Every day'
  const set = new Set(days)
  if (WEEKDAYS.every(d => set.has(d)) && set.size === 5) return 'Weekdays'
  if (WEEKENDS.every(d => set.has(d)) && set.size === 2) return 'Weekends'

  const ordered = DAY_ORDER.filter(d => set.has(d))
  const indices = ordered.map(d => DAY_ORDER.indexOf(d))
  const isContiguous = indices.every((idx, i) => i === 0 || idx === indices[i - 1] + 1)
  if (isContiguous && ordered.length > 2) {
    return `${DAY_SHORT[ordered[0]]}–${DAY_SHORT[ordered[ordered.length - 1]]}`
  }
  return ordered.map(d => DAY_SHORT[d]).join(', ')
}

function intensityColor(intensity: number): string {
  if (intensity <= 30) return 'bg-green-500'
  if (intensity <= 60) return 'bg-amber-500'
  return 'bg-red-500'
}

export function AlarmCard({ group, onEdit, onDelete, onTest, isTesting = false }: AlarmCardProps) {
  const label = formatDayRange(group.days)

  return (
    <div
      className={clsx(
        'rounded-2xl border p-3 sm:p-4',
        group.enabled
          ? 'border-zinc-800 bg-zinc-900'
          : 'border-dashed border-amber-500/30 bg-zinc-900/50',
      )}
    >
      <div className="flex items-start gap-3">
        <Bell size={18} className="mt-1 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-white">
              {formatTime12h(group.time)}
            </span>
            {!group.enabled && (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[9px] font-medium uppercase text-amber-500">
                Paused
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-zinc-400">{label}</p>

          <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-500">
            <span className="capitalize">{group.vibrationPattern}</span>
            <span>·</span>
            <span>
              {group.duration}
              s
            </span>
            <span>·</span>
            <span>
              {group.alarmTemperature}
              °F
            </span>
          </div>

          <div className="mt-2 flex items-center gap-1.5">
            <div className="h-1 flex-1 rounded-full bg-zinc-800 overflow-hidden">
              <div
                className={clsx('h-full rounded-full transition-all', intensityColor(group.vibrationIntensity))}
                style={{ width: `${group.vibrationIntensity}%` }}
              />
            </div>
            <span className="text-[9px] font-medium tabular-nums text-zinc-400">
              {group.vibrationIntensity}
              %
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={onTest}
            disabled={isTesting}
            className="flex h-8 w-8 items-center justify-center rounded-full text-amber-400 transition-colors active:bg-zinc-800 disabled:opacity-50"
            aria-label={`Test ${label} alarm`}
          >
            <Play size={14} />
          </button>
          <button
            onClick={onEdit}
            className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 transition-colors active:bg-zinc-800 active:text-sky-400"
            aria-label={`Edit ${label} alarm`}
          >
            <Pencil size={14} />
          </button>
          <button
            onClick={onDelete}
            className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-600 transition-colors active:bg-zinc-800 active:text-red-400"
            aria-label={`Delete ${label} alarm`}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}
