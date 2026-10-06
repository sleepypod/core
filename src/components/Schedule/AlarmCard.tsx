'use client'

import type { MouseEvent } from 'react'
import { Bell, Pencil, Play } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card, GhostIcon } from '@/src/components/ds'
import type { DayOfWeek } from '@/src/lib/scheduleTime'
import { formatTime12h } from '@/src/lib/scheduleTime'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { formatSetpointF } from '@/src/lib/tempUtils'
import { formatDayRange } from './scheduleFormat'

export interface AlarmGroup {
  /** All underlying alarm_schedules row ids in this group */
  ids: number[]
  days: DayOfWeek[]
  time: string
  vibrationIntensity: number
  vibrationPattern: 'rise' | 'double'
  duration: number
  alarmTemperature: number
  /** Minutes before `time` in which movement fires the alarm early; 0 = off. */
  wakeWindow: number
  enabled: boolean
}

interface AlarmCardProps {
  group: AlarmGroup
  onEdit: () => void
  onTest: () => void
  isTesting?: boolean
}

function stop(fn: () => void) {
  return (e: MouseEvent) => {
    e.stopPropagation()
    fn()
  }
}

/** Amber bell, mono wake time, repeat days and `10s buzz · rise · 84°`. Paused alarms are dashed. */
export function AlarmCard({ group, onEdit, onTest, isTesting = false }: AlarmCardProps) {
  const { unit } = useTemperatureUnit()
  const label = formatDayRange(group.days, { named: true })
  const paused = !group.enabled

  return (
    <Card
      flat
      dashed={paused}
      tone={paused ? 'warn' : undefined}
      onClick={onEdit}
      className="flex-row items-center gap-3 px-4 py-3.5 min-[900px]:items-start"
    >
      <Bell size={16} className={cn('shrink-0 min-[900px]:mt-[3px]', paused ? 'text-fg-3' : 'text-warn')} />
      <div className="flex min-w-0 flex-1 flex-col min-[900px]:gap-0.5">
        <span className={cn('font-mono text-[17px] min-[900px]:text-lg', paused && 'text-fg-2')}>
          {formatTime12h(group.time)}
        </span>
        <span className="text-xs text-fg-2">
          {label}
          {paused && (
            <>
              {' · '}
              <span className="text-warn">paused</span>
            </>
          )}
          <span className="min-[900px]:hidden">
            {' · '}
            {group.duration}
            s buzz
            {group.wakeWindow > 0 && ` · ${group.wakeWindow} min window`}
          </span>
        </span>
        <span className="mt-1 hidden font-mono text-[11px] text-fg-3 min-[900px]:block">
          {`${group.duration}s buzz · ${group.vibrationPattern} · ${formatSetpointF(group.alarmTemperature, unit, { includeUnit: false })}${group.wakeWindow > 0 ? ` · ${group.wakeWindow} min window` : ''}`}
        </span>
      </div>
      <div className="-my-1.5 -mr-2 flex shrink-0 flex-col">
        <GhostIcon
          icon={Play}
          size={14}
          label={`Test ${label} alarm`}
          disabled={isTesting}
          className={paused ? undefined : 'text-warn hover:text-warn'}
          onClick={stop(onTest)}
        />
        <GhostIcon
          icon={Pencil}
          size={14}
          label={`Edit ${label} alarm`}
          className="hidden min-[900px]:flex"
          onClick={stop(onEdit)}
        />
      </div>
    </Card>
  )
}
