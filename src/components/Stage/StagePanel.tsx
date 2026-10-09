'use client'

import { Minus, Plus, Power, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { IconButton, TempBackdrop } from '@/src/components/ds'
import { TempControl } from '@/src/components/TempControl/TempControl'
import type { NightPhaseKey } from '@/src/components/TempScreen/nightPhases'
import { HoldDurationRow, HoldStatus } from '@/src/components/TempScreen/TemperatureHoldControls'
import { TempStepper, stepperBackdrop } from '@/src/components/TempScreen/TempStepper'
import type { StepperTab } from '@/src/components/TempScreen/TempStepper'
import type { SideNightPhases } from '@/src/components/TempScreen/useNightPhases'
import type { TempUnit } from '@/src/lib/tempUtils'
import type { ControlVariant, TempDisplay } from '@/src/providers/PrefsProvider'
import type { TemperatureControlStatus } from '@/src/temperature/controller'
import type { SideStatus, StageSide } from './stageColors'

export interface StagePanelProps {
  open: boolean
  side: StageSide
  name: string
  /** "Left · In bed", "Both sides"… */
  scope: string
  isOn: boolean
  /** A notice (priming, pump stall) blocks this side: Resume, the dial and hold take no input. */
  paused?: boolean
  powerDisabled: boolean
  onPower: () => void
  onClose: () => void
  status: SideStatus
  control: TemperatureControlStatus | undefined
  onResumed: () => void
  controlStyle: ControlVariant
  display: TempDisplay
  unit: TempUnit
  targetF: number
  bedF: number | null
  stepDisabled: boolean
  onPreview: (f: number) => void
  onCommit: (f: number) => void
  onStep: (delta: number) => void
  holdMinutes: number
  onHoldChange: (minutes: number) => void
  stepper: {
    tab: StepperTab
    onTabChange: (tab: StepperTab) => void
    schedule: SideNightPhases
    onStepPhase: (phase: NightPhaseKey, delta: number) => void
    now: Date
  }
}

/**
 * The selected side's controls, floating at the right of the stage below the header,
 * as tall as its content (scrolling only when the room between the header and the
 * timeline runs out). Slides in 24px when a side is selected. The control follows the
 * device's Temperature control setting: dial, slider, or Now · Night · Dawn, which
 * paints the same time-of-day and temperature backdrop as its card.
 */
export function StagePanel({
  open, side, name, scope, isOn, paused = false, powerDisabled, onPower, onClose, status, control, onResumed,
  controlStyle, display, unit, targetF, bedF, stepDisabled, onPreview, onCommit, onStep, holdMinutes, onHoldChange, stepper,
}: StagePanelProps) {
  const isStepper = controlStyle === 'stepper'
  // The ownership line already reads "Off" for a side that's switched off.
  const repeatsOwner = status.text === 'OFF' && control?.blocked === 'off'
  return (
    <aside
      role="region"
      aria-label={`${name} controls`}
      aria-hidden={!open}
      data-testid="stage-panel"
      data-open={open}
      className={cn(
        'absolute isolate z-10 flex w-[320px] flex-col gap-3.5 overflow-y-auto rounded-[14px] border p-[22px] transition-[transform,opacity] duration-[360ms] ease-standard',
        'right-7 top-[104px] max-h-[calc(100%-336px)] max-[899px]:inset-x-3 max-[899px]:top-auto max-[899px]:bottom-[232px] max-[899px]:w-auto max-[899px]:max-h-[52dvh]',
        open ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-6 opacity-0',
      )}
      style={{ background: 'rgba(15,15,17,0.88)', borderColor: '#26262a', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
    >
      {isStepper && <TempBackdrop {...stepperBackdrop({ ...stepper, targetF, isOn })} />}
      <div className="flex items-center gap-2.5">
        <span className="shrink-0 text-[18px] font-medium text-[#ececec]">{name}</span>
        <span className="min-w-0 truncate font-mono text-[10px] uppercase tracking-[0.14em] text-[#8b8b92]">{scope}</span>
        <button
          type="button"
          aria-label={isOn ? `Turn ${name} off` : `Turn ${name} on`}
          aria-pressed={isOn}
          disabled={powerDisabled}
          onClick={onPower}
          className={cn(
            'ml-auto flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-colors disabled:cursor-default disabled:opacity-45',
            isOn ? 'border-[#ececec] bg-[#ececec] text-[#0b0b0c]' : 'border-[#26262a] bg-transparent text-[#8b8b92] hover:bg-white/[0.08]',
          )}
        >
          <Power size={15} />
        </button>
        <button type="button" aria-label="Close panel" onClick={onClose} className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#8b8b92] hover:bg-white/[0.08] hover:text-[#ececec]">
          <X size={15} />
        </button>
      </div>

      <HoldStatus
        side={side}
        control={control}
        onResumed={onResumed}
        disabled={paused}
        prefix={repeatsOwner ? undefined : <span className="shrink-0 tracking-[0.12em]" style={{ color: status.color }} data-testid="stage-panel-status">{status.text}</span>}
      />

      <div inert={paused || undefined} className={cn('contents', paused && '[&>*]:opacity-40')} data-testid="stage-panel-body">
        <div className="flex justify-center">
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
                  variant={controlStyle}
                  display={display}
                  targetF={targetF}
                  bedF={bedF}
                  unit={unit}
                  power={isOn}
                  onChange={onPreview}
                  onCommit={onCommit}
                  statusOverride={isOn ? undefined : 'OFF'}
                />
              )}
        </div>

        {!isStepper && (
          <div className="flex items-center justify-center gap-4">
            <IconButton icon={Minus} size={48} label="Cooler" disabled={stepDisabled} onClick={() => onStep(-1)} />
            <IconButton icon={Plus} size={48} label="Warmer" disabled={stepDisabled} onClick={() => onStep(1)} />
          </div>
        )}

        <HoldDurationRow holdMinutes={holdMinutes} onDurationChange={onHoldChange} />
      </div>
    </aside>
  )
}
