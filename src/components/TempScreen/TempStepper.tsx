'use client'

import Link from 'next/link'
import { Minus, Plus } from 'lucide-react'
import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { directionFor } from '@/src/components/TempControl/TempControl'
import { formatTime12h, hhmmToMinutes } from '@/src/lib/scheduleTime'
import { setpointFToDisplay, type TempUnit } from '@/src/lib/tempUtils'
import type { TempDisplay } from '@/src/providers/PrefsProvider'
import { tempHue } from '@/src/lib/tempColors'
import { formatForDisplay, type NightPhaseKey } from './nightPhases'
import { summarizeDays } from './tempScreenUtils'
import type { SideNightPhases } from './useNightPhases'

export type StepperTab = 'now' | NightPhaseKey

const TAB_LABEL: Record<StepperTab, string> = { now: 'Now', night: 'Night', dawn: 'Dawn' }

const STATUS_WORD = { cool: 'Cooling', warm: 'Warming', hold: 'Holding' } as const

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
  /** Night / Dawn: tonight's schedule for this side. */
  schedule: SideNightPhases
  onStepPhase: (phase: NightPhaseKey, delta: number) => void
  className?: string
}

function hueStyle(f: number | null): CSSProperties | undefined {
  return f == null ? undefined : ({ '--h': tempHue(f) } as CSSProperties)
}

interface Selection {
  tab: StepperTab
  targetF: number
  isOn: boolean
  schedule: SideNightPhases
  now: Date
}

/** The tab actually shown — Night / Dawn fall back to Now without a schedule. */
function selectedTab({ tab, schedule }: Pick<Selection, 'tab' | 'schedule'>): StepperTab {
  return tab === 'now' || schedule.phases?.[tab] != null ? tab : 'now'
}

/**
 * TempBackdrop props for the stepper's selection: the selected temperature,
 * and the moment it is about — now, or the phase's midpoint. The card that
 * hosts the stepper paints it (Card `backdrop`), so it fills the whole card.
 */
export function stepperBackdrop(sel: Selection): { tempF: number | null, minutes: number, dimmed: boolean } {
  const selected = selectedTab(sel)
  const phase = selected === 'now' ? null : sel.schedule.phases?.[selected] ?? null
  return {
    tempF: selected === 'now' ? sel.targetF : sel.schedule.valueF(selected),
    minutes: phase
      ? hhmmToMinutes(phase.start) + phase.minutes / 2
      : sel.now.getHours() * 60 + sel.now.getMinutes(),
    dimmed: selected === 'now' && !sel.isOn,
  }
}

/**
 * Eight Sleep–style temperature module: Now / Night / Dawn tabs, each with
 * its temperature, and a − value + stepper for the selected one. Now drives
 * the pod directly (manual hold); Night and Dawn edit tonight's schedule.
 * Pair with <Card backdrop={<TempBackdrop {...stepperBackdrop(...)} />}>.
 * 250px tall like the dial and slider, so the card's layout doesn't move
 * when switching.
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
  const { phases } = schedule
  const valueFor = (t: StepperTab): number | null => (t === 'now' ? targetF : schedule.valueF(t))
  const available = (t: StepperTab) => t === 'now' || phases?.[t] != null

  const selected = selectedTab({ tab, schedule })
  const valueF = valueFor(selected)
  const phase = selected === 'now' ? null : phases?.[selected] ?? null
  const off = selected === 'now' && !isOn

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
  const stepDisabled = selected === 'now' ? nowDisabled : valueF == null

  let caption: string
  if (selected === 'now') {
    const bed = bedF == null ? null : Math.round(setpointFToDisplay(bedF, unit) ?? bedF)
    const deg = display === 'degrees' ? '' : `${formatForDisplay(targetF, unit, 'degrees')} · `
    caption = off
      ? 'Off'
      : `${deg}${STATUS_WORD[directionFor(targetF, bedF)]}${bed == null ? '' : ` · bed ${bed}°${unit}`}`
  }
  else if (phase && phases) {
    const deg = display === 'degrees' || valueF == null ? '' : `${formatForDisplay(valueF, unit, 'degrees')} · `
    caption = `${deg}${formatTime12h(phase.start)} – ${formatTime12h(phase.end)} · ${summarizeDays(phases.days)}`
  }
  else {
    caption = ''
  }

  return (
    <div
      data-no-swipe
      data-testid="temp-stepper"
      className={cn('flex w-full flex-col', className)}
      style={{ height: 250 }}
    >
      <div role="tablist" aria-label="When" className="flex gap-2 px-3 pt-3.5">
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
              disabled={!ok}
              onClick={() => onTabChange(t)}
              className="flex min-w-0 cursor-pointer flex-col items-center gap-1.5 bg-transparent p-0 disabled:cursor-default"
              style={{ flexGrow: grow[t], flexBasis: 0 }}
            >
              <span
                className={cn('font-mono text-[15px] leading-none', f != null && ok && !(t === 'now' && !isOn) ? 'sp-temp-ink' : 'text-fg-3')}
                style={hueStyle(f)}
              >
                {t === 'now' && !isOn ? 'Off' : f != null && ok ? formatForDisplay(f, unit, display) : '—'}
              </span>
              <span className={cn('h-[3px] w-full rounded-full', isSel ? 'bg-fg' : 'bg-line-2')} />
              <span className={cn('text-[13px]', isSel ? 'text-fg' : 'text-fg-2')}>{TAB_LABEL[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="flex flex-1 items-center justify-center gap-4">
        <button
          type="button"
          aria-label={`Cooler ${TAB_LABEL[selected].toLowerCase()}`}
          disabled={stepDisabled}
          onClick={() => step(-1)}
          className="flex size-14 shrink-0 cursor-pointer items-center justify-center rounded-full bg-fg/[0.07] text-fg transition-colors hover:bg-fg/[0.12] disabled:cursor-default disabled:opacity-40"
        >
          <Minus size={22} />
        </button>
        <div
          className={cn('min-w-[118px] text-center font-mono text-[52px] font-light leading-none', off && 'text-fg-3')}
          aria-live="polite"
          data-testid="stepper-value"
        >
          {off ? 'Off' : valueF == null ? '—' : formatForDisplay(valueF, unit, display)}
        </div>
        <button
          type="button"
          aria-label={`Warmer ${TAB_LABEL[selected].toLowerCase()}`}
          disabled={stepDisabled}
          onClick={() => step(1)}
          className="flex size-14 shrink-0 cursor-pointer items-center justify-center rounded-full bg-fg/[0.07] text-fg transition-colors hover:bg-fg/[0.12] disabled:cursor-default disabled:opacity-40"
        >
          <Plus size={22} />
        </button>
      </div>

      <div className="flex h-10 flex-col items-center gap-0.5 px-2 text-center font-mono text-xs text-fg-2">
        <span className="max-w-full truncate">{schedule.error && selected !== 'now' ? schedule.error : caption}</span>
        {!phases && !schedule.isLoading && (
          <Link href="/schedule" className="text-fg underline-offset-2 hover:underline">Set up Night & Dawn</Link>
        )}
      </div>
    </div>
  )
}
