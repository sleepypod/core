'use client'

import { Trash2 } from 'lucide-react'
import { GhostIcon, Stepper } from '@/src/components/ds'
import { formatTime12h } from '@/src/lib/scheduleTime'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { displayToSetpointF, setpointFToDisplay } from '@/src/lib/tempUtils'
import { TONE_VAR, tempTone } from './scheduleFormat'

export interface EditorSetPoint {
  id: number
  time: string
  /** °F */
  temperature: number
}

const MIN_TEMP = 55
const MAX_TEMP = 110

interface SetPointCardProps {
  point: EditorSetPoint
  /** Receives the new temperature in °F. */
  onSetTemp: (id: number, temperatureF: number) => void
  onDelete: (id: number) => void
  /** Tapping the time opens the set-point editor. */
  onTapTime: (point: EditorSetPoint) => void
  disabled?: boolean
  /** Marks the point that drives the Pod's auto power-on / power-off. */
  autoLabel?: 'on' | 'off' | null
}

/**
 * Editor row: tone dot, time, power on/off label, temperature stepper
 * (in the user's unit, stored as °F) and delete.
 */
export function SetPointCard({
  point,
  onSetTemp,
  onDelete,
  onTapTime,
  disabled = false,
  autoLabel = null,
}: SetPointCardProps) {
  const { unit } = useTemperatureUnit()
  const display = Math.round(setpointFToDisplay(point.temperature, unit) ?? point.temperature)
  const time = formatTime12h(point.time)

  return (
    <div className="flex items-center gap-3 border-t border-line pt-3" data-testid="set-point-row">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <span
          className="block size-2 shrink-0 rounded-full"
          style={{ background: autoLabel === 'off' ? 'var(--text-3)' : TONE_VAR[tempTone(point.temperature)] }}
        />
        <button
          type="button"
          onClick={() => onTapTime(point)}
          disabled={disabled}
          aria-label={`Edit set point ${time}`}
          className="w-[78px] shrink-0 cursor-pointer whitespace-nowrap border-0 bg-transparent p-0 text-left font-mono text-sm text-fg hover:text-fg-2 disabled:cursor-default"
        >
          {time}
        </button>
        {autoLabel && (
          <span className="truncate text-xs text-fg-2">{autoLabel === 'on' ? 'Power on' : 'Power off'}</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        <Stepper
          value={display}
          min={Math.round(setpointFToDisplay(MIN_TEMP, unit) ?? MIN_TEMP)}
          max={Math.round(setpointFToDisplay(MAX_TEMP, unit) ?? MAX_TEMP)}
          disabled={disabled}
          label={`temperature at ${time}`}
          onChange={v => onSetTemp(point.id, Math.max(MIN_TEMP, Math.min(MAX_TEMP, Math.round(displayToSetpointF(v, unit) ?? point.temperature))))}
        />
        <GhostIcon
          icon={Trash2}
          size={15}
          label={`Delete set point ${time}`}
          className="-mr-2 text-fg-3 hover:text-danger"
          disabled={disabled}
          onClick={() => onDelete(point.id)}
        />
      </div>
    </div>
  )
}
