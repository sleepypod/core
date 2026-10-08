'use client'

import { Minus, Plane, Plus, Power } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button, Card, IconButton, StatusDot, TempBackdrop } from '@/src/components/ds'
import { TempControl } from '@/src/components/TempControl/TempControl'
import type { TempUnit } from '@/src/lib/tempUtils'
import type { ControlVariant, TempDisplay } from '@/src/providers/PrefsProvider'
import type { Side } from '@/src/providers/SideProvider'
import type { TemperatureControlStatus } from '@/src/temperature/controller'
import type { NightPhaseKey } from './nightPhases'
import { HoldDurationRow, HoldStatus } from './TemperatureHoldControls'
import { TempStepper, stepperBackdrop, type StepperTab } from './TempStepper'
import type { SideNightPhases } from './useNightPhases'

/** 'in' / 'out' when occupancy can be sensed; null = unknown (claim omitted). */
export type Presence = 'in' | 'out' | null

export interface SideCardProps {
  side: Side
  name: string
  presence: Presence
  away: boolean
  /** Single sleeper: the home side's name this away side is linked to. */
  linkedTo?: string
  scheduleStatus?: string
  control: TemperatureControlStatus | undefined
  variant: ControlVariant
  display: TempDisplay
  unit: TempUnit
  targetF: number
  bedF: number | null
  isOn: boolean
  /** A notice (priming, pump stall) blocks this side: dimmed, inert, status PAUSED. */
  paused?: boolean
  stepDisabled: boolean
  powerDisabled: boolean
  holdMinutes: number
  onHoldChange: (minutes: number) => void
  onPreview: (f: number) => void
  onCommit: (f: number) => void
  onStep: (delta: number) => void
  onPower: () => void
  onResumed: () => void
  /** Phones show one side at a time; the other card is hidden below 900px. */
  hiddenOnPhone?: boolean
  /** Stepper variant only: Now / Night / Dawn selection and tonight's schedule. */
  stepper?: {
    tab: StepperTab
    onTabChange: (tab: StepperTab) => void
    schedule: SideNightPhases
    onStepPhase: (phase: NightPhaseKey, delta: number) => void
    now: Date
  }
}

function followingLine(linkedTo: string) {
  return `Following ${linkedTo}’s schedule`
}

// A plain away side says so in its AWAY status, so the line only adds whose schedule it follows.
function sideLine(side: Side, presence: Presence, away: boolean, linkedTo?: string) {
  const parts = [side === 'left' ? 'Left' : 'Right']
  if (linkedTo) parts.push(followingLine(linkedTo))
  else if (presence && !away) parts.push(presence === 'in' ? 'In bed' : 'Out of bed')
  return parts.join(' · ')
}

/**
 * One side of the bed: header (name + power), ownership line, the control
 * (dial/slider with −/+ below, or the Now/Night/Dawn stepper) and the
 * hold duration. Phones also fold the side line into the ownership row and
 * use 52px −/+ buttons (48px on desktop). An away side is a lasting state, not
 * a notice: a dashed, see-through card with a mono AWAY status, and while it
 * is off just "Off" and a Turn on button.
 */
export function SideCard({
  side,
  name,
  presence,
  away,
  linkedTo,
  scheduleStatus,
  control,
  variant,
  display,
  unit,
  targetF,
  bedF,
  isOn,
  paused = false,
  stepDisabled,
  powerDisabled,
  holdMinutes,
  onHoldChange,
  onPreview,
  onCommit,
  onStep,
  onPower,
  onResumed,
  hiddenOnPhone,
  stepper,
}: SideCardProps) {
  const isStepper = variant === 'stepper' && stepper != null
  const awayOff = away && !isOn
  const line = [sideLine(side, presence, away, linkedTo), scheduleStatus].filter(Boolean).join(' · ')

  return (
    <Card
      role="group"
      aria-label={`${name} (${side})`}
      aria-disabled={paused || undefined}
      inert={paused || undefined}
      dashed={away}
      flat={away}
      className={cn('gap-3.5 p-[18px] min-[900px]:p-5', hiddenOnPhone && 'max-[899px]:hidden', paused && 'pointer-events-none opacity-40')}
      backdrop={isStepper && !away ? <TempBackdrop {...stepperBackdrop({ ...stepper, targetF, isOn })} /> : undefined}
    >
      <div className="flex items-center gap-2">
        <span className={cn('truncate text-[15px] font-medium', away && 'text-fg-2')}>{name}</span>
        {away
          ? (
              <>
                <StatusDot tone="muted" />
                <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] tracking-[0.06em] text-fg-2" data-testid="side-away">
                  <Plane size={12} />
                  AWAY
                </span>
              </>
            )
          : presence && <StatusDot tone={presence === 'in' ? 'ok' : 'muted'} />}
        <button
          type="button"
          aria-label={isOn ? 'Turn off' : 'Turn on'}
          aria-pressed={isOn}
          disabled={powerDisabled}
          onClick={onPower}
          hidden={awayOff}
          className={cn(
            'ml-auto flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border bg-black/20 transition-colors hover:bg-white/[0.08] disabled:cursor-default disabled:opacity-45',
            !isOn ? 'border-fg-2 text-fg-2' : side === 'left' ? 'border-side-left text-side-left' : 'border-side-right text-side-right',
          )}
        >
          <Power size={16} />
        </button>
      </div>

      <HoldStatus
        side={side}
        control={control}
        prefix={(
          <>
            {paused && <span className="shrink-0 text-fg" data-testid="side-paused">Paused</span>}
            <span className="shrink-0 min-[900px]:hidden">{line}</span>
            {/* Desktop hides the side line (the dot carries presence), so a following side says so here. */}
            {(linkedTo || scheduleStatus) && <span className="hidden min-[900px]:inline">{[linkedTo ? followingLine(linkedTo) : null, scheduleStatus].filter(Boolean).join(' · ')}</span>}
          </>
        )}
        onResumed={onResumed}
      />

      {awayOff
        ? (
            <div className="flex flex-col items-center gap-4 py-6 min-[900px]:mt-3" data-testid="side-away-off">
              <span className="font-mono text-[52px] font-light leading-none text-fg-3">Off</span>
              <Button onClick={onPower} disabled={powerDisabled}>Turn on</Button>
            </div>
          )
        : (
            <>
              <div className="flex justify-center min-[900px]:mt-3">
                {isStepper
                  ? (
                      <TempStepper
                        tab={stepper.tab}
                        onTabChange={stepper.onTabChange}
                        schedule={stepper.schedule}
                        onStepPhase={stepper.onStepPhase}
                        unit={unit}
                        display={display}
                        targetF={targetF}
                        bedF={bedF}
                        isOn={isOn}
                        nowDisabled={stepDisabled}
                        onStepNow={onStep}
                      />
                    )
                  : (
                      <TempControl
                        variant={variant === 'stepper' ? 'dial' : variant}
                        display={display}
                        targetF={targetF}
                        bedF={bedF}
                        unit={unit}
                        power={isOn}
                        onChange={onPreview}
                        onCommit={onCommit}
                        statusOverride={paused ? 'PAUSED' : isOn ? undefined : 'OFF'}
                      />
                    )}
              </div>

              {!isStepper && (
                <div className="flex items-center justify-center gap-5 min-[900px]:gap-4">
                  <IconButton
                    icon={Minus}
                    size={52}
                    label="Cooler"
                    className="min-[900px]:!size-12"
                    disabled={stepDisabled}
                    onClick={() => onStep(-1)}
                  />
                  <IconButton
                    icon={Plus}
                    size={52}
                    label="Warmer"
                    className="min-[900px]:!size-12"
                    disabled={stepDisabled}
                    onClick={() => onStep(1)}
                  />
                </div>
              )}

              <HoldDurationRow holdMinutes={holdMinutes} onDurationChange={onHoldChange} />
            </>
          )}
    </Card>
  )
}
