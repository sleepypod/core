'use client'

import Link from 'next/link'
import { activeSleeperSides, scheduleSourceSide } from '@/src/lib/singleSleeper'
import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { Link2, Power } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button, NoticeStack, PageHeader, Skeleton } from '@/src/components/ds'
import { AutopilotStatusChip } from '@/src/components/Autopilot/AutopilotStatusChip'
import { EnvironmentInfoPanel } from '@/src/components/EnvironmentInfo/EnvironmentInfoPanel'
import { SideSelector } from '@/src/components/SideSelector/SideSelector'
import { useTempView } from '@/src/components/Stage/stagePrefs'
import { ViewSwitch } from '@/src/components/Stage/ViewSwitch'
import { useDeviceStatus } from '@/src/hooks/useDeviceStatus'
import { useSideNames } from '@/src/hooks/useSideNames'
import type { TempUnit } from '@/src/lib/tempUtils'
import { usePrefs } from '@/src/providers/PrefsProvider'
import { useShownSides, useSide, type Side } from '@/src/providers/SideProvider'
import { trpc } from '@/src/utils/trpc'
import { AlarmCard } from './AlarmCard'
import { LastNightCard } from './LastNightCard'
import { ScheduleTimeline } from './ScheduleTimeline'
import { SideCard, type Presence } from './SideCard'
import { stepForDisplay, type NightPhaseKey } from './nightPhases'
import type { StepperTab } from './TempStepper'
import { TonightCard, useNow } from './TonightCard'
import { useNightPhases } from './useNightPhases'
import { useSideTemperature } from './useSideTemperature'
import { useTempNotices } from './useTempNotices'

const TempStage = dynamic(() => import('../Stage/TempStage').then(m => m.TempStage), { ssr: false, loading: () => <div aria-hidden="true" className="fixed inset-0 z-30 bg-[#0b0b0c] min-[900px]:left-[224px]" /> })

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
 * - device.clearAlarm / device.snoozeAlarm, pumpAlerts.* → notice banners (useTempNotices)
 * - device.dismissPrimeNotification → the prime-complete toast (useTempNotices)
 * - biometrics.getOccupancy → in-bed dot (omitted when presence can't be sensed)
 * - settings.getAll → unit, side names, away mode
 * - Schedule and sleep timeline (desktop): schedules.getAll, biometrics.getSleepRecords,
 *   health.thermalHistory
 * - context cards: schedules.getAll, environment.getLatestBedTemp,
 *   environment.getLatestAmbientLight, biometrics.getLatestSleep/getVitalsSummary
 *
 * Link sides mirrors every change (drag, ±, power) to both sides. All off
 * powers down whichever sides are on, linked or not.
 *
 * Both temperature zones remain available in solo and partner-away modes.
 * Schedule ownership follows the explicit unused-zone policy; linking only
 * controls which zones receive the user's temperature and power adjustments.
 */
export const TempScreen = () => {
  const { isLinked, toggleLink, primarySide, singleSleeperSide } = useSide()
  const shown = useShownSides()
  // One side away: the sleeper's schedule, context and timeline.
  const contextSide = singleSleeperSide ?? primarySide
  const { control: variant, tempDisplay } = usePrefs()
  const { sideName } = useSideNames()

  // Device status via WebSocket (2s push) with HTTP fallback
  const { status, isLoading: statusLoading, refetch } = useDeviceStatus()

  const { data: settings } = trpc.settings.getAll.useQuery({})
  const bedState = { ...settings?.sides, ...settings?.device }
  const scheduleSide = (side: Side): Side => scheduleSourceSide(side, bedState) ?? side
  const soloSide = settings?.device?.bedMode === 'solo-left' ? 'left' : settings?.device?.bedMode === 'solo-right' ? 'right' : null
  const awaySides = SIDES.filter(s => settings?.sides?.[s]?.awayMode && (!soloSide || s === soloSide))
  const awayNames = awaySides.map(s => sideName(s))
  const returnDates = awaySides.flatMap((s) => {
    const date = settings?.sides?.[s]?.awayReturn
    return date ? [new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: settings?.device?.timezone })] : []
  })
  const sleeperLabel = soloSide
    ? `Solo sleeper · ${sideName(soloSide)}${awayNames.length ? ' · Away' : ''}`
    : awayNames.length ? `${awayNames.join(' & ')} away${returnDates.length === 1 ? ` · Until ${returnDates[0]}` : ''}` : 'Two sleepers'
  const unit: TempUnit = (settings?.device?.temperatureUnit as TempUnit) ?? 'F'
  const { data: occupancy } = trpc.biometrics.getOccupancy.useQuery(undefined, { refetchInterval: 30_000 })

  // The stage replaces the card layout with the full-screen 3D bed; it has its own data wiring.
  const [view, setView] = useTempView()
  const showStage = view === 'stage'
  // v switches to the stage from the cards; the stage handles its own keys.
  useEffect(() => {
    if (showStage) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || (event.key !== 'v' && event.key !== 'V')) return
      if (target && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName))) return
      event.preventDefault()
      setView('stage')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showStage, setView])
  const [holdMinutes, setHoldMinutes] = useState(30)
  const refetchStatus = () => {
    void refetch()
  }
  // Pump stall, priming and alarm banners; a notice's blocksSides pauses those cards.
  // The stage derives its own, so the prime toast fires from whichever view is up.
  const { notices, blocked } = useTempNotices(status, refetchStatus, { enabled: !showStage })

  const controls = {
    left: useSideTemperature('left', status?.leftSide, holdMinutes, refetch, blocked.left),
    right: useSideTemperature('right', status?.rightSide, holdMinutes, refetch, blocked.right),
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

  // A side a notice blocks (priming, its pump stall) takes no changes, even mirrored ones,
  // and drives none: its partner doesn't move from it.
  const targetsFor = (side: Side): Side[] => blocked[side] ? [] : (isLinked ? SIDES : [side]).filter(s => !blocked[s])
  const scheduleTargetsFor = (side: Side): Side[] => [...new Set(targetsFor(side).map(s => scheduleSide(s)))]

  const handleStepPhase = (side: Side, phase: NightPhaseKey, delta: number) => {
    for (const s of scheduleTargetsFor(side)) nightPhases[s].nudge(phase, delta)
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
          <ViewSwitch view={view} onChange={setView} />
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

  if (showStage) return <TempStage onExit={() => setView('cards')} />

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

  return (
    <>
      {header}

      <NoticeStack notices={notices} />

      <Link href="/settings?section=sides" className="mb-3 inline-flex rounded-ctl border border-line-2 px-3 py-2 text-sm text-fg-2 hover:text-fg" aria-label={`Manage sleepers: ${sleeperLabel}`}>
        {sleeperLabel}
      </Link>

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
              scheduleStatus={!scheduleSourceSide(side, bedState) ? 'Schedule off' : !activeSleeperSides(bedState).includes(side) && bedState.unusedZoneMode === 'independent' ? 'Independent schedule' : undefined}
              linkedTo={scheduleSide(side) !== side ? sideName(scheduleSide(side)) : undefined}
              control={status?.temperatureControl?.[side]}
              variant={variant}
              display={tempDisplay}
              unit={unit}
              targetF={c.targetF}
              bedF={c.bedF}
              isOn={c.isOn}
              paused={blocked[side]}
              stepDisabled={!c.isOn || blocked[side]}
              powerDisabled={c.powerPending || blocked[side]}
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
                    schedule: nightPhases[scheduleSide(side)],
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
            <TonightCard side={contextSide} unit={unit} />
          </div>
          <EnvironmentInfoPanel side={contextSide} unit={unit} />
          <LastNightCard side={contextSide} name={sideName(contextSide)} />
          <AlarmCard side={contextSide} />
        </div>
      </div>

      <ScheduleTimeline unit={unit} sides={shown} className="max-[899px]:hidden" />
    </>
  )
}
