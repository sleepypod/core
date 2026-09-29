'use client'

import { useState } from 'react'
import { Link2, Power } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button, PageHeader, Skeleton } from '@/src/components/ds'
import { AutopilotStatusChip } from '@/src/components/Autopilot/AutopilotStatusChip'
import { EnvironmentInfoPanel } from '@/src/components/EnvironmentInfo/EnvironmentInfoPanel'
import { SideSelector } from '@/src/components/SideSelector/SideSelector'
import { useDeviceStatus } from '@/src/hooks/useDeviceStatus'
import { useSideNames } from '@/src/hooks/useSideNames'
import type { TempUnit } from '@/src/lib/tempUtils'
import { usePrefs } from '@/src/providers/PrefsProvider'
import { useSide, type Side } from '@/src/providers/SideProvider'
import { trpc } from '@/src/utils/trpc'
import { AlarmBanner } from './AlarmBanner'
import { AlarmCard } from './AlarmCard'
import { LastNightCard } from './LastNightCard'
import { PrimeCompleteNotification } from './PrimeCompleteNotification'
import { PrimingIndicator } from './PrimingIndicator'
import { PumpStallNotification } from './PumpStallNotification'
import { ScheduleTimeline } from './ScheduleTimeline'
import { SideCard, type Presence } from './SideCard'
import { stepForDisplay, type NightPhaseKey } from './nightPhases'
import type { StepperTab } from './TempStepper'
import { TonightCard, useNow } from './TonightCard'
import { useNightPhases } from './useNightPhases'
import { useSideTemperature } from './useSideTemperature'

const SIDES: Side[] = ['left', 'right']

/*
 * Grid: phones (<900px) stack switcher → one SideCard → context cards.
 * Desktop puts both SideCards side by side once they fit (each needs the
 * 280px control + padding), and adds the 300px context column when there is
 * room for all three; otherwise the context cards wrap below in two columns.
 */
const GRID = 'grid gap-3.5 min-[900px]:gap-4 min-[900px]:@min-[680px]:grid-cols-2 min-[900px]:@min-[976px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_300px]'
const CONTEXT = 'grid content-start gap-3.5 min-[900px]:gap-3 min-[900px]:@min-[680px]:col-span-2 min-[900px]:@min-[680px]:grid-cols-2 min-[900px]:@min-[976px]:col-span-1 min-[900px]:@min-[976px]:grid-cols-1'

/**
 * Temp (home) screen.
 *
 * Device router wiring:
 * - device.getStatus (WS-preferred via useDeviceStatus) → per-side current/target
 *   temp, power, temperature ownership, alarm, priming, pump stall, snooze
 * - device.setTemperature / device.setPower → SideCard −/+/drag/power (optimistic;
 *   −/+ bursts pool into one write)
 * - schedules.getAll / schedules.batchUpdate → stepper variant's Night / Dawn
 *   (shifts tonight's set points; see useNightPhases)
 * - device.resumeTemperature → Resume on an active manual hold
 * - device.clearAlarm / device.snoozeAlarm → AlarmBanner
 * - device.dismissPrimeNotification → PrimeCompleteNotification
 * - biometrics.getOccupancy → in-bed dot (omitted when presence can't be sensed)
 * - settings.getAll → unit, side names, away mode
 * - Schedule and sleep timeline (desktop): schedules.getAll, biometrics.getSleepRecords,
 *   health.thermalHistory
 * - context cards: schedules.getAll, environment.getLatestBedTemp,
 *   environment.getLatestAmbientLight, biometrics.getLatestSleep/getVitalsSummary
 *
 * Link sides mirrors every change (drag, ±, power) to both sides. All off
 * powers down whichever sides are on, linked or not.
 */
export const TempScreen = () => {
  const { isLinked, toggleLink, primarySide } = useSide()
  const { control: variant, tempDisplay } = usePrefs()
  const { sideName } = useSideNames()

  // Device status via WebSocket (2s push) with HTTP fallback
  const { status, isLoading: statusLoading, refetch } = useDeviceStatus()

  const { data: settings } = trpc.settings.getAll.useQuery({})
  const unit: TempUnit = (settings?.device?.temperatureUnit as TempUnit) ?? 'F'
  const { data: occupancy } = trpc.biometrics.getOccupancy.useQuery(undefined, { refetchInterval: 30_000 })

  const [holdMinutes, setHoldMinutes] = useState(30)

  const controls = {
    left: useSideTemperature('left', status?.leftSide, holdMinutes, refetch),
    right: useSideTemperature('right', status?.rightSide, holdMinutes, refetch),
  }

  // Stepper variant: Night / Dawn read and edit tonight's schedule per side.
  const isStepper = variant === 'stepper'
  const now = useNow()
  // Per side, so choosing Night on one card doesn't switch the other — unless linked.
  const [stepperTab, setStepperTab] = useState<Record<Side, StepperTab>>({ left: 'now', right: 'now' })
  const handleTabChange = (side: Side, tab: StepperTab) => {
    setStepperTab(prev => ({ ...prev, ...Object.fromEntries(targetsFor(side).map(s => [s, tab])) }))
  }
  const nightPhases = {
    left: useNightPhases('left', now, unit, tempDisplay, isStepper),
    right: useNightPhases('right', now, unit, tempDisplay, isStepper),
  }

  const targetsFor = (side: Side): Side[] => (isLinked ? SIDES : [side])

  const handleStepPhase = (side: Side, phase: NightPhaseKey, delta: number) => {
    for (const s of targetsFor(side)) nightPhases[s].nudge(phase, delta)
  }

  /** Continuous drag — visual only, no hardware calls. */
  const handlePreview = (side: Side, f: number) => {
    for (const s of targetsFor(side)) controls[s].preview(f)
  }

  /** Drag end / keyboard — send to hardware, hold until status confirms. */
  const handleCommit = (side: Side, f: number) => {
    for (const s of targetsFor(side)) controls[s].commitTemp(f)
  }

  /** ± — shown immediately, sent once taps pause (one hardware write per burst). */
  const handleStep = (side: Side, delta: number) => {
    const f = stepForDisplay(controls[side].targetF, delta, unit, tempDisplay)
    for (const s of targetsFor(side)) controls[s].stepTemp(f)
  }

  const handlePower = (side: Side) => {
    const next = !controls[side].isOn
    for (const s of targetsFor(side)) controls[s].commitPower(next)
  }

  const anyOn = SIDES.some(s => controls[s].isOn)
  const handleAllOff = () => {
    for (const s of SIDES) if (controls[s].isOn) controls[s].commitPower(false)
  }

  const presenceFor = (side: Side): Presence => {
    const occ = occupancy?.[side]
    if (!occ) return null
    if (occ.occupied) return 'in'
    return occ.available ? 'out' : null
  }

  const header = (
    <PageHeader
      title="Temperature"
      right={(
        <>
          <AutopilotStatusChip className="no-underline" />
          <Button
            icon={Link2}
            aria-pressed={isLinked}
            onClick={toggleLink}
            className={cn('hidden min-[900px]:inline-flex', isLinked ? 'bg-active text-fg' : 'text-fg-2')}
          >
            {isLinked ? 'Sides linked' : 'Link sides'}
          </Button>
          <Button icon={Power} onClick={handleAllOff} disabled={!anyOn}>
            All off
          </Button>
        </>
      )}
    />
  )

  if (statusLoading) {
    return (
      <>
        {header}
        <div className={GRID}>
          <Skeleton className="h-[520px]" />
          <Skeleton className="h-[520px] max-[899px]:hidden" />
          <div className={CONTEXT}>
            <span className="sp-label" role="status">Connecting…</span>
          </div>
        </div>
      </>
    )
  }

  const stallNotices = status?.pumpStallNotifications
  const isPriming = status?.isPriming ?? false

  return (
    <>
      {header}

      {/* Pump stall — highest priority, dismissible per-side */}
      {SIDES.map((side) => {
        const notice = stallNotices?.[side]
        return notice && (
          <PumpStallNotification
            key={side}
            side={side}
            rpm={notice.rpm}
            trippedAt={notice.trippedAt}
            alertId={notice.alertId}
            onAction={() => { void refetch() }}
          />
        )
      })}

      {isPriming && <PrimingIndicator />}

      {status?.primeCompletedNotification != null && !isPriming && (
        <PrimeCompleteNotification onDismiss={() => { void refetch() }} />
      )}

      {/* Alarm banner — active vibration with snooze/stop, or snoozed countdown */}
      <AlarmBanner
        leftAlarmActive={status?.leftSide?.isAlarmVibrating ?? false}
        rightAlarmActive={status?.rightSide?.isAlarmVibrating ?? false}
        snooze={status?.snooze}
        onActionComplete={() => { void refetch() }}
      />

      <SideSelector
        className="min-[900px]:hidden"
        overrides={{
          left: { targetF: controls.left.targetF, isOn: controls.left.isOn },
          right: { targetF: controls.right.targetF, isOn: controls.right.isOn },
        }}
      />

      <div className={GRID}>
        {SIDES.map((side) => {
          const c = controls[side]
          return (
            <SideCard
              key={side}
              side={side}
              name={sideName(side)}
              presence={presenceFor(side)}
              away={Boolean(settings?.sides?.[side]?.awayMode)}
              control={status?.temperatureControl?.[side]}
              variant={variant}
              display={tempDisplay}
              unit={unit}
              targetF={c.targetF}
              bedF={c.bedF}
              isOn={c.isOn}
              stepDisabled={!c.isOn || c.tempPending}
              powerDisabled={c.powerPending}
              holdMinutes={holdMinutes}
              onHoldChange={setHoldMinutes}
              onPreview={f => handlePreview(side, f)}
              onCommit={f => handleCommit(side, f)}
              onStep={delta => handleStep(side, delta)}
              onPower={() => handlePower(side)}
              onResumed={() => { void refetch() }}
              hiddenOnPhone={side !== primarySide}
              stepper={isStepper
                ? {
                    tab: stepperTab[side],
                    onTabChange: tab => handleTabChange(side, tab),
                    schedule: nightPhases[side],
                    onStepPhase: (phase, delta) => handleStepPhase(side, phase, delta),
                    now,
                  }
                : undefined}
            />
          )
        })}

        <div className={CONTEXT}>
          {/* Desktop: the Schedule and sleep timeline below covers tonight. */}
          <div className="min-[900px]:hidden">
            <TonightCard side={primarySide} unit={unit} />
          </div>
          <EnvironmentInfoPanel side={primarySide} unit={unit} />
          <LastNightCard side={primarySide} name={sideName(primarySide)} />
          <AlarmCard side={primarySide} />
        </div>
      </div>

      <ScheduleTimeline unit={unit} className="max-[899px]:hidden" />
    </>
  )
}
