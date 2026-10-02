'use client'

import { Toggle } from '@/src/components/ds'

interface ScheduleToggleProps {
  /** Whether the schedule is currently enabled */
  enabled: boolean
  /** Called when user toggles the switch */
  onToggle: () => void
  /** Whether a mutation is in-flight */
  isLoading?: boolean
}

/**
 * Header switch that pauses/resumes the whole schedule. Labelled "Schedule"
 * on desktop and On/Off on phones.
 */
export function ScheduleToggle({
  enabled,
  onToggle,
  isLoading = false,
}: ScheduleToggleProps) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-fg-2 min-[900px]:gap-2.5">
      <span className="hidden min-[900px]:inline">Schedule</span>
      <span className="min-[900px]:hidden">{enabled ? 'On' : 'Off'}</span>
      <Toggle
        on={enabled}
        onChange={onToggle}
        disabled={isLoading}
        label="Toggle schedule"
        className="max-[899px]:hidden"
      />
      <Toggle
        on={enabled}
        onChange={onToggle}
        disabled={isLoading}
        size="md"
        label="Toggle schedule"
        className="min-[900px]:hidden"
      />
    </div>
  )
}
