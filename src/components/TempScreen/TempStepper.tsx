'use client'

import { Popover } from '@base-ui/react/popover'
import { Info, Minus, Plus } from 'lucide-react'
import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { formatTime12h, hhmmToMinutes } from '@/src/lib/scheduleTime'
import { tempHue } from '@/src/lib/tempColors'
import { setpointFToDisplay, type TempUnit } from '@/src/lib/tempUtils'
import type { TempDisplay } from '@/src/providers/PrefsProvider'
import { formatForDisplay, TEMPLATE_BEDTIME, TEMPLATE_WAKE, type NightPhaseKey } from './nightPhases'
import { summarizeDays } from './tempScreenUtils'
import type { SideNightPhases } from './useNightPhases'

export type StepperTab = 'now' | NightPhaseKey

const TAB_LABEL: Record<StepperTab, string> = { now: 'Now', night: 'Night', dawn: 'Dawn' }

export interface TempStepperProps {
  tab: StepperTab
  onTabChange: (tab: StepperTab) => void
  unit: TempUnit
  display: TempDisplay
  /** Now: the side's live target, bed temperature and power. */
  targetF: number
  bedF: number | null
  isOn: boolean
  nowDisabled: boolean
  onStepNow: (delta: number) => void
  /** Night / Dawn: tonight's schedule for this side (or the template while `draft`). */
  schedule: SideNightPhases
  onStepPhase: (phase: NightPhaseKey, delta: number) => void
  className?: string
}

function hueStyle(f: number | null): CSSProperties | undefined {
  return f == null ? undefined : ({ '--h': tempHue(f) } as CSSProperties)
}

/** Heating / Cooling / Holding by whole display degrees of set point vs bed. */
export function heatState(targetF: number, bedF: number | null, unit: TempUnit): 'Heating' | 'Cooling' | 'Holding' {
  if (bedF == null) return 'Holding'
  const t = Math.round(setpointFToDisplay(targetF, unit) ?? targetF)
  const b = Math.round(setpointFToDisplay(bedF, unit) ?? bedF)
  return t > b ? 'Heating' : t < b ? 'Cooling' : 'Holding'
}

interface Selection {
  tab: StepperTab
  targetF: number
  isOn: boolean
  schedule: SideNightPhases
  now: Date
}

/** The tab actually shown — Night / Dawn fall back to Now until phases load. */
function selectedTab({ tab, schedule }: Pick<Selection, 'tab' | 'schedule'>): StepperTab {
  return tab === 'now' || schedule.phases?.[tab] != null ? tab : 'now'
}

/**
 * TempBackdrop props for the stepper's selection: the selected temperature,
 * and the moment it is about — now, or the phase's midpoint. Powered off, the
 * card goes flat. The card that hosts the stepper paints it (Card
 * `backdrop`), so it fills the whole card.
 */
export function stepperBackdrop(sel: Selection): { tempF: number | null, minutes: number, off: boolean } {
  const selected = selectedTab(sel)
  const phase = selected === 'now' ? null : sel.schedule.phases?.[selected] ?? null
  return {
    tempF: selected === 'now' ? sel.targetF : sel.schedule.valueF(selected),
    minutes: phase
      ? hhmmToMinutes(phase.start) + phase.minutes / 2
      : sel.now.getHours() * 60 + sel.now.getMinutes(),
    off: !sel.isOn,
  }
}

/**
 * Eight Sleep–style temperature module: Now / Night / Dawn tabs, each with
 * its temperature, and a − value + stepper for the selected one. Now drives
 * the pod directly (manual hold); Night and Dawn edit tonight's schedule.
 * With no schedule, Night / Dawn show the template curve's values and the
 * first − / + creates it.
 *
 * Pair with <Card backdrop={<TempBackdrop {...stepperBackdrop(...)} />}>.
 */
export function TempStepper({
  tab,
  onTabChange,
  unit,
  display,
  targetF,
  bedF,
  isOn,
  nowDisabled,
  onStepNow,
  schedule,
  onStepPhase,
  className,
}: TempStepperProps) {
  const { phases, draft } = schedule
  const valueFor = (t: StepperTab): number | null => (t === 'now' ? targetF : schedule.valueF(t))
  const available = (t: StepperTab) => t === 'now' || phases?.[t] != null

  const selected = selectedTab({ tab, schedule })
  const valueF = valueFor(selected)
  const phase = selected === 'now' ? null : phases?.[selected] ?? null
  const off = !isOn

  const nightMin = phases?.night.minutes ?? 1
  const dawnMin = phases?.dawn?.minutes ?? 0
  // Night + Dawn share three parts of the width in proportion to their length.
  const grow: Record<StepperTab, number> = {
    now: 1.2,
    night: Math.max(1, (3 * nightMin) / (nightMin + dawnMin)),
    dawn: dawnMin > 0 ? Math.max(1, (3 * dawnMin) / (nightMin + dawnMin)) : 1,
  }

  const step = (delta: number) => {
    if (selected === 'now') onStepNow(delta)
    else onStepPhase(selected, delta)
  }
  const stepDisabled = off || (selected === 'now' ? nowDisabled : valueF == null)

  const bed = bedF == null ? '—' : `${Math.round(setpointFToDisplay(bedF, unit) ?? bedF)}°${unit}`
  const caption = phase && phases && !off
    ? `${formatTime12h(phase.start)} – ${formatTime12h(phase.end)}`
    : `${off ? 'Off' : heatState(targetF, bedF, unit)} · bed ${bed}`
  const days = phase && phases && !off && !schedule.error ? summarizeDays(phases.days) : null
  const hint = !draft
    ? null
    : selected === 'now'
      ? (
          <button
            type="button"
            onClick={() => onTabChange('night')}
            className="cursor-pointer bg-transparent p-0 text-fg underline-offset-2 hover:underline"
          >
            Set up Night & Dawn
          </button>
        )
      : (
          <span className="flex items-center gap-1 text-fg-2">
            Suggested · − / + saves it
            <SuggestionInfo />
          </span>
        )

  return (
    <div data-no-swipe data-testid="temp-stepper" className={cn('flex w-full flex-col', className)} style={{ height: 250 }}>
      <div
        role="tablist"
        aria-label="When"
        className={cn('flex gap-2 px-3 pt-3.5 transition-opacity', off && 'pointer-events-none opacity-35')}
      >
        {(['now', 'night', 'dawn'] as const).map((t) => {
          const f = valueFor(t)
          const ok = available(t)
          const isSel = t === selected
          return (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={isSel}
              disabled={!ok || off}
              onClick={() => onTabChange(t)}
              className="flex min-w-0 cursor-pointer flex-col items-center gap-1.5 bg-transparent p-0 disabled:cursor-default"
              style={{ flexGrow: grow[t], flexBasis: 0 }}
            >
              <span
                className={cn(
                  'font-mono text-[15px] leading-none',
                  f != null && ok ? 'sp-temp-ink' : 'text-fg-3',
                  draft && t !== 'now' && 'opacity-60',
                )}
                style={hueStyle(f)}
              >
                {f != null && ok ? formatForDisplay(f, unit, display) : '—'}
              </span>
              <span className={cn('h-[3px] w-full rounded-full', isSel ? 'bg-fg' : 'bg-line-2')} />
              <span className={cn('text-[13px]', isSel ? 'text-fg' : 'text-fg-2')}>{TAB_LABEL[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="flex flex-1 items-center justify-center gap-4">
        <StepButton icon={Minus} label={`Cooler ${TAB_LABEL[selected].toLowerCase()}`} disabled={stepDisabled} off={off} onClick={() => step(-1)} />
        <div
          className={cn('min-w-[118px] text-center font-mono text-[52px] font-light leading-none', off && 'text-fg-2')}
          aria-live="polite"
          data-testid="stepper-value"
        >
          {off ? 'Off' : valueF == null ? '—' : formatForDisplay(valueF, unit, display)}
        </div>
        <StepButton icon={Plus} label={`Warmer ${TAB_LABEL[selected].toLowerCase()}`} disabled={stepDisabled} off={off} onClick={() => step(1)} />
      </div>

      <div className="flex h-10 flex-col items-center gap-0.5 px-2 text-center font-mono text-[13px] text-status">
        <span className="max-w-full truncate" data-testid="stepper-status">
          {schedule.error && selected !== 'now' ? schedule.error : caption}
        </span>
        {!off && (hint ?? (days && <span className="max-w-full truncate text-fg-2" data-testid="stepper-days">{days}</span>))}
      </div>
    </div>
  )
}

function StepButton({ icon: Icon, label, disabled, off, onClick }: {
  icon: typeof Minus
  label: string
  disabled: boolean
  off: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex size-14 shrink-0 cursor-pointer items-center justify-center rounded-full bg-fg/[0.07] text-fg transition-[background-color,opacity] hover:bg-fg/[0.12] disabled:cursor-default',
        off ? 'pointer-events-none opacity-35' : 'disabled:opacity-40',
      )}
    >
      <Icon size={22} />
    </button>
  )
}

/** Explains the template values shown before a side has a Night / Dawn schedule. */
function SuggestionInfo() {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="About suggested temperatures"
        className="flex size-5 cursor-pointer items-center justify-center rounded-full bg-transparent p-0 text-fg-2 hover:text-fg"
      >
        <Info size={13} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" sideOffset={6} className="z-50">
          <Popover.Popup className="max-w-[260px] rounded-ctl border border-line-2 bg-surface p-3 font-sans text-xs leading-relaxed text-fg-2 shadow-[var(--shadow-dialog)] outline-none">
            <p className="mb-1.5 font-medium text-fg">These are suggestions</p>
            <p>
              {`This side has no Night & Dawn schedule yet, so these come from the balanced sleep curve (${formatTime12h(TEMPLATE_BEDTIME)} – ${formatTime12h(TEMPLATE_WAKE)}). `}
              Nothing is saved until you tap − or +. Then the curve is saved, with your temperature, to every night that has no schedule. Fine-tune times on the Schedule page.
            </p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
