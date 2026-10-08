'use client'

import { useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { Card, CardHeader, InlineError, SelectValue, SettingRow, StatusDot, TextField, Toggle } from '@/src/components/ds'
import { SectionColumns } from './SettingsLayout'

interface SideData {
  side: 'left' | 'right'
  name: string
  awayMode: boolean
  awayStart?: string | null
  awayReturn?: string | null
  alwaysOn: boolean
  autoOffEnabled: boolean
  autoOffMinutes: number
}

interface SideSettingsFormProps {
  side: 'left' | 'right'
  sideData: SideData
  /**
   * Whether presence can be sensed for this side (calibrated capSense2 + fresh
   * frame). `null` while the occupancy query is loading. When `false`, auto-off
   * can't reliably tell the bed is empty, so the toggle is gated off — enabling
   * it would do nothing (the watcher stands down on unsensable presence).
   */
  presenceAvailable: boolean | null
}

const AUTO_OFF_DURATION_OPTIONS = [5, 10, 15, 30, 45, 60, 90, 120] as const

function localDateTime(iso: string): string {
  const date = new Date(iso)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function formatMinutes(mins: number): string {
  if (mins < 60) return `${mins} min`
  return `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ''}`
}

/**
 * Per-side settings: profile name, away mode, always on, and auto-off.
 */
export function SideSettingsForm({ side, sideData, presenceAvailable }: SideSettingsFormProps) {
  const d = sideData ?? {
    side,
    name: side === 'left' ? 'Left' : 'Right',
    awayMode: false,
    alwaysOn: false,
    autoOffEnabled: false,
    autoOffMinutes: 30,
  }

  // key forces remount when server data changes, replacing the useEffect sync pattern
  return (
    <SideCards
      key={`${d.side}-${d.name}-${d.awayMode}-${d.awayStart}-${d.awayReturn}-${d.alwaysOn}-${d.autoOffEnabled}-${d.autoOffMinutes}`}
      data={d}
      presenceAvailable={presenceAvailable}
    />
  )
}

function SideCards({ data, presenceAvailable }: { data: SideData, presenceAvailable: boolean | null }) {
  const utils = trpc.useUtils()
  const [name, setName] = useState(data.name)
  const [awayMode, setAwayMode] = useState(data.awayMode)
  const [alwaysOn, setAlwaysOn] = useState(data.alwaysOn)
  const [autoOffEnabled, setAutoOffEnabled] = useState(data.autoOffEnabled)
  const [autoOffMinutes, setAutoOffMinutes] = useState(data.autoOffMinutes)

  const mutation = trpc.settings.updateSide.useMutation({
    onSuccess: () => utils.settings.getAll.invalidate(),
  })

  const isPending = mutation.isPending
  const sideLabel = data.side === 'left' ? 'Left' : 'Right'
  // Block enabling auto-off when presence can't be sensed; always allow turning
  // it off. `null` (loading) is treated as available to avoid a flicker that
  // would block the toggle before the occupancy query resolves.
  const presenceUnavailable = presenceAvailable === false
  const autoOffToggleDisabled = isPending || (presenceUnavailable && !autoOffEnabled)

  function handleNameBlur() {
    const trimmed = name.trim()
    if (trimmed && trimmed !== data.name) {
      mutation.mutate({ side: data.side, name: trimmed })
    }
    else {
      setName(data.name) // revert
    }
  }

  function handleNameKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      ;(e.target as HTMLInputElement).blur()
    }
  }

  function handleAwayToggle() {
    const newVal = !awayMode
    setAwayMode(newVal)
    mutation.mutate({ side: data.side, awayMode: newVal })
  }

  function handleAlwaysOnToggle() {
    const newVal = !alwaysOn
    setAlwaysOn(newVal)
    // Always On and Auto-off are mutually exclusive — turning on Always On
    // disables Auto-off so the firmware never powers down mid-session.
    if (newVal && autoOffEnabled) {
      setAutoOffEnabled(false)
      mutation.mutate({ side: data.side, alwaysOn: true, autoOffEnabled: false })
    }
    else {
      mutation.mutate({ side: data.side, alwaysOn: newVal })
    }
  }

  function handleAutoOffToggle() {
    const newVal = !autoOffEnabled
    setAutoOffEnabled(newVal)
    // Mirror image of the Always On rule above.
    if (newVal && alwaysOn) {
      setAlwaysOn(false)
      mutation.mutate({ side: data.side, autoOffEnabled: true, alwaysOn: false })
    }
    else {
      mutation.mutate({ side: data.side, autoOffEnabled: newVal })
    }
  }

  function handleAutoOffMinutesChange(minutes: number) {
    setAutoOffMinutes(minutes)
    mutation.mutate({ side: data.side, autoOffMinutes: minutes })
  }

  const minuteOptions = (AUTO_OFF_DURATION_OPTIONS as readonly number[]).includes(autoOffMinutes)
    ? AUTO_OFF_DURATION_OPTIONS
    : [...AUTO_OFF_DURATION_OPTIONS, autoOffMinutes].sort((a, b) => a - b)

  const presence = presenceAvailable === null
    ? <StatusDot tone="muted" label="Checking presence" />
    : presenceAvailable
      ? <StatusDot tone="ok" label="Presence available" />
      : <StatusDot tone="warn" label="Presence unavailable" />

  const left = (
    <>
      <Card>
        <CardHeader title="Profile" />
        <div className="grid grid-cols-2 gap-3">
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs text-fg-2">Name</span>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              onBlur={handleNameBlur}
              onKeyDown={handleNameKeyDown}
              maxLength={20}
              disabled={isPending}
              placeholder={sideLabel}
              className="min-w-0 rounded-ctl border border-line-2 bg-field px-3 py-[9px] text-sm text-fg outline-none placeholder:text-fg-3 focus:border-fg-3 disabled:opacity-45"
            />
          </label>
          <TextField label="Side" mono={false} value={sideLabel} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Away mode" subtitle="Temporarily pause this sleeper’s tracking and alarms. Their profile and schedules are saved. The other-zone preference controls temperature while one sleeper is home." />
        <SettingRow label="Away">
          <Toggle
            on={awayMode}
            onChange={handleAwayToggle}
            disabled={isPending}
            label={`Toggle away mode for ${sideLabel} side`}
          />
        </SettingRow>
        <SettingRow className="flex-col items-stretch min-[600px]:flex-row min-[600px]:items-center" label="Return date" sub="Optional. Uses your local time.">
          <input
            aria-label={`Return date for ${sideLabel} side`}
            type="datetime-local"
            className="rounded-ctl border border-line-2 bg-field px-2 py-1 text-sm"
            defaultValue={data.awayReturn ? localDateTime(data.awayReturn) : ''}
            disabled={isPending}
            onBlur={(event) => {
              const value = event.target.value
              const awayReturn = value ? new Date(value).toISOString() : null
              if (awayReturn !== (data.awayReturn ?? null)) mutation.mutate({ side: data.side, awayReturn })
            }}
          />
        </SettingRow>
      </Card>
    </>
  )

  const right = (
    <>
      <Card>
        <CardHeader title="Auto-off" subtitle="Turns this side off after you leave the bed" right={presence} />
        <SettingRow label="Turn off after">
          <SelectValue
            label="Auto-off after"
            value={autoOffMinutes}
            options={minuteOptions.map(m => ({ value: m, label: formatMinutes(m) }))}
            onChange={handleAutoOffMinutesChange}
            disabled={isPending || !autoOffEnabled}
          />
          <Toggle
            on={autoOffEnabled}
            onChange={handleAutoOffToggle}
            disabled={autoOffToggleDisabled}
            label={`Toggle auto-off for ${sideLabel} side`}
          />
        </SettingRow>
        {/* Presence-sensing gate: explain why auto-off is unavailable / inactive */}
        {presenceUnavailable && (
          <p className="text-xs leading-[1.4] text-warn">
            {autoOffEnabled
              ? 'Presence sensing is unavailable, so auto-off is currently inactive. Calibrate the capacitance sensor for this side to restore it.'
              : 'Requires presence sensing. Calibrate the capacitance sensor for this side to enable auto-off.'}
          </p>
        )}
        <SettingRow label="Always on" sub="Prevents the firmware’s 8-hour auto-off">
          <Toggle
            on={alwaysOn}
            onChange={handleAlwaysOnToggle}
            disabled={isPending}
            label={`Toggle always on for ${sideLabel} side`}
          />
        </SettingRow>
      </Card>
      {mutation.error && <InlineError>{mutation.error.message}</InlineError>}
    </>
  )

  return <SectionColumns left={left} right={right} />
}
