'use client'

import { Circle, CircleCheck } from 'lucide-react'
import type { KeyboardEvent, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { trpc } from '@/src/utils/trpc'
import { Card, CardHeader, InlineError, SegmentedControl, SettingRow, TempBackdrop } from '@/src/components/ds'
import { TempControl } from '@/src/components/TempControl/TempControl'
import { nightPhases, type NightPhaseKey, type ScheduleTempRow } from '@/src/components/TempScreen/nightPhases'
import { TempStepper, stepperBackdrop } from '@/src/components/TempScreen/TempStepper'
import { DAYS_OF_WEEK } from '@/src/lib/scheduleTime'
import { usePrefs, type ControlVariant, type TempDisplay, type ThemePref } from '@/src/providers/PrefsProvider'

const THEME_OPTIONS: { value: ThemePref, label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
]

/** Units row bound to the pod-wide temperatureUnit device setting. */
export function UnitsControl({ unit }: { unit: string }) {
  const utils = trpc.useUtils()
  const mutation = trpc.settings.updateDevice.useMutation({
    onSuccess: () => utils.settings.getAll.invalidate(),
  })
  const value = (mutation.isPending ? mutation.variables?.temperatureUnit : undefined) ?? (unit === 'C' ? 'C' : 'F')
  return (
    <>
      <SegmentedControl
        ariaLabel="Units"
        value={value}
        options={[{ value: 'F', label: '°F' }, { value: 'C', label: '°C' }]}
        onChange={u => mutation.mutate({ temperatureUnit: u })}
      />
      {mutation.error && <InlineError className="sr-only">{mutation.error.message}</InlineError>}
    </>
  )
}

const TEMP_DISPLAY_OPTIONS: { value: TempDisplay, label: string }[] = [
  { value: 'degrees', label: 'Degrees' },
  { value: 'offset', label: 'Offset ±' },
  { value: 'level', label: 'Eight Sleep' },
]

/** Big number on the Temp screen: degrees, ± from 80°F like the old dial, or Eight Sleep's −10…+10 levels. */
export function TempDisplayControl() {
  const { tempDisplay, setTempDisplay } = usePrefs()
  return (
    <SegmentedControl ariaLabel="Show temperature as" value={tempDisplay} options={TEMP_DISPLAY_OPTIONS} onChange={setTempDisplay} />
  )
}

export function ThemeControl() {
  const { theme, setTheme } = usePrefs()
  return (
    <SegmentedControl ariaLabel="Theme" value={theme} options={THEME_OPTIONS} onChange={setTheme} />
  )
}

/** Tiny dial / slider glyphs for the phone option cards. */
function MiniDial() {
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden>
      <circle cx="22" cy="22" r="17" fill="none" stroke="var(--border-2)" strokeWidth="3" strokeDasharray="80 107" strokeLinecap="round" transform="rotate(135 22 22)" />
      <circle cx="22" cy="22" r="17" fill="none" stroke="var(--accent-cool)" strokeWidth="3" strokeDasharray="31 107" strokeLinecap="round" transform="rotate(135 22 22)" />
    </svg>
  )
}

function MiniSlider() {
  return (
    <div className="relative h-11 w-[18px] overflow-hidden rounded-[9px] bg-line-2" aria-hidden>
      <span className="absolute inset-x-0 bottom-0 h-2/5 bg-cool" />
    </div>
  )
}

function MiniStepper() {
  return (
    <div className="flex h-11 items-center gap-1.5" aria-hidden>
      <span className="flex size-4 items-center justify-center rounded-full bg-line-2 text-[11px] leading-none text-fg-2">−</span>
      <span className="font-mono text-[15px] leading-none">+2</span>
      <span className="flex size-4 items-center justify-center rounded-full bg-line-2 text-[11px] leading-none text-fg-2">+</span>
    </div>
  )
}

const PREVIEW_ROWS: ScheduleTempRow[] = DAYS_OF_WEEK.flatMap((dayOfWeek, i) => [
  { id: i * 3 + 1, dayOfWeek, time: '22:30', temperature: 76, enabled: true },
  { id: i * 3 + 2, dayOfWeek, time: '01:30', temperature: 74, enabled: true },
  { id: i * 3 + 3, dayOfWeek, time: '05:00', temperature: 85, enabled: true },
])

/** Static Now / Night / Dawn module for the picker preview. */
function StepperPreview({ display }: { display: TempDisplay }) {
  const now = new Date()
  const phases = nightPhases(PREVIEW_ROWS, now)
  const schedule = {
    phases,
    draft: false,
    isLoading: false,
    error: null,
    saving: false,
    valueF: (p: NightPhaseKey) => (phases?.[p] ? Math.round(phases[p].temperatureF) : null),
    nudge: () => {},
  }
  return (
    <Card className="w-[280px] p-0" backdrop={<TempBackdrop {...stepperBackdrop({ tab: 'now', targetF: 81, isOn: true, schedule, now })} />}>
      <TempStepper
        tab="now"
        onTabChange={() => {}}
        unit="F"
        display={display}
        targetF={81}
        bedF={80}
        isOn
        nowDisabled
        onStepNow={() => {}}
        schedule={schedule}
        onStepPhase={() => {}}
      />
    </Card>
  )
}

function OptionCard({ selected, onSelect, label, preview, mini }: {
  selected: boolean
  onSelect: () => void
  label: string
  preview: ReactNode
  mini: ReactNode
}) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect()
    }
  }
  const Icon = selected ? CircleCheck : Circle
  return (
    <div
      role="radio"
      aria-checked={selected}
      aria-label={label}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={cn(
        'flex min-w-0 flex-1 cursor-pointer flex-col items-center gap-2 rounded-[10px] border px-1.5 py-3 outline-none focus-visible:border-fg-3 @min-[800px]:gap-3.5 @min-[800px]:rounded-card @min-[800px]:px-3 @min-[800px]:pb-4 @min-[800px]:pt-5',
        selected ? 'border-fg' : 'border-line-2 hover:bg-active',
      )}
    >
      <div className="pointer-events-none hidden @min-[800px]:block">{preview}</div>
      <div className="@min-[800px]:hidden">{mini}</div>
      <span className={cn('flex items-center gap-2 text-[11px] whitespace-nowrap @min-[800px]:text-sm', !selected && 'text-fg-2')}>
        <Icon size={15} className="hidden @min-[800px]:block" />
        {label}
      </span>
    </div>
  )
}

/** Dial / slider choice with a live preview of each variant. */
export function TempControlPicker() {
  const { control, setControl, tempDisplay } = usePrefs()
  const options: { value: ControlVariant, label: string, mini: ReactNode }[] = [
    { value: 'dial', label: 'Dial', mini: <MiniDial /> },
    { value: 'slider', label: 'Slider', mini: <MiniSlider /> },
    { value: 'stepper', label: 'Now · Night · Dawn', mini: <MiniStepper /> },
  ]
  return (
    <div role="radiogroup" aria-label="Temperature control" className="grid grid-cols-3 gap-2 @min-[800px]:gap-3 @max-[1100px]:@min-[800px]:grid-cols-2">
      {options.map(o => (
        <OptionCard
          key={o.value}
          selected={control === o.value}
          onSelect={() => setControl(o.value)}
          label={o.label}
          mini={o.mini}
          preview={o.value === 'stepper'
            ? <StepperPreview display={tempDisplay} />
            : <TempControl variant={o.value} display={tempDisplay} targetF={76} bedF={80} />}
        />
      ))}
    </div>
  )
}

/**
 * Appearance: per-device display preferences (localStorage) plus the
 * pod-wide temperature unit.
 */
export function AppearanceSettings({ temperatureUnit }: { temperatureUnit: string }) {
  return (
    <div className="flex flex-col gap-3.5">
      <Card>
        <CardHeader title="Temperature control" subtitle="Used on the Temp screen of this device" />
        <TempControlPicker />
        <SettingRow label="Show as" sub="Offset counts whole degrees from 80°F (0), like the old dial. Eight Sleep uses its −10…+10 levels.">
          <TempDisplayControl />
        </SettingRow>
      </Card>
      <Card>
        <CardHeader title="Display" />
        <SettingRow label="Theme">
          <ThemeControl />
        </SettingRow>
        <SettingRow label="Units">
          <UnitsControl unit={temperatureUnit} />
        </SettingRow>
      </Card>
    </div>
  )
}
