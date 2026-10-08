'use client'

import { Link2, Power } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { SideCard } from '@/src/components/TempScreen/SideCard'
import type { Presence } from '@/src/components/TempScreen/SideCard'
import { stepForDisplay } from '@/src/components/TempScreen/nightPhases'
import type { NightPhaseKey } from '@/src/components/TempScreen/nightPhases'
import type { StepperTab } from '@/src/components/TempScreen/TempStepper'
import { useNow } from '@/src/components/TempScreen/TonightCard'
import { useNightPhases } from '@/src/components/TempScreen/useNightPhases'
import { useSideTemperature } from '@/src/components/TempScreen/useSideTemperature'
import { useTempNotices } from '@/src/components/TempScreen/useTempNotices'
import { NoticeStack } from '@/src/components/ds'
import { latestThermalReading, THERMAL_STALE_SECONDS } from '@/src/components/ThermalBed/thermalData'
import type { Zones } from '@/src/components/ThermalBed/thermalData'
import { useDeviceStatus } from '@/src/hooks/useDeviceStatus'
import { useSensorFrame, useSensorStream } from '@/src/hooks/useSensorStream'
import { useSideNames } from '@/src/hooks/useSideNames'
import { formatSensorC, toF } from '@/src/lib/tempUtils'
import type { TempUnit } from '@/src/lib/tempUtils'
import { usePrefs } from '@/src/providers/PrefsProvider'
import { useTimeFormat } from '@/src/providers/TimeFormatProvider'
import { useSide } from '@/src/providers/SideProvider'
import { trpc } from '@/src/utils/trpc'
import StageCanvas from './StageCanvas'
import type { StageCanvasHandle, StageMode } from './StageCanvas'
import { SideLabel, ZoneLabel } from './StageLabels'
import { StagePanel } from './StagePanel'
import { StageTimeline } from './StageTimeline'
import { ZONE_NAMES } from './heatTexture'
import { STAGE, STAGE_SIDES, formatStageTemp, sideStatus, tempColor } from './stageColors'
import type { StageSide } from './stageColors'
import { useStageAutoReturn, useStageZones } from './stagePrefs'
import { ViewSwitch } from './ViewSwitch'
import type { StageLabelRefs, StageSceneState } from './stageScene'
import { CAMERA } from './stageCamera'
import { HOUR, clock, scheduledAt, sideActivity, stageCurves, stageWindow } from './stageTimelineLogic'
import type { StageActivity } from './stageTimelineLogic'

const EMPTY: Zones = [null, null, null]
const KEY_HINTS: [string, string][] = [
  ['hover', 'zones'], ['1 / 2', 'side'], ['drag', 'set temp on a side'], ['↑ ↓', '±1°'], ['L', 'link'], ['space', 'power'], ['v', 'view'], ['esc', 'cards'],
]
const PILL = 'flex h-[34px] cursor-pointer items-center gap-2 rounded-full border px-3.5 text-[13px] transition-colors disabled:cursor-default disabled:opacity-45'
const GLASS = { background: 'rgba(11,11,12,0.7)' } as const

const mean = (values: (number | null)[]): number | null => {
  const present = values.filter((v): v is number => v != null)
  return present.length ? present.reduce((a, b) => a + b, 0) / present.length : null
}

/**
 * The six surface sensors (°C, live stream with a stored fallback) plus the room
 * readings that ride on the same frame. Readings older than 90 s read as unknown.
 */
function useBedSurface() {
  useSensorStream({ sensors: ['bedTemp', 'bedTemp2'] })
  const older = useSensorFrame('bedTemp')
  const newer = useSensorFrame('bedTemp2')
  const [nowS, setNowS] = useState(() => Date.now() / 1000)
  useEffect(() => {
    const timer = setInterval(() => setNowS(Date.now() / 1000), 5000)
    return () => clearInterval(timer)
  }, [])
  const live = latestThermalReading(older, newer)
  const liveFresh = live !== null && nowS - live.ts < THERMAL_STALE_SECONDS
  const stored = trpc.environment.getLatestBedTemp.useQuery({ unit: 'C' }, { enabled: !liveFresh, refetchInterval: 30_000, staleTime: 15_000 })
  const reading = latestThermalReading(older, newer, stored.data)
  const stale = reading === null || nowS - reading.ts >= THERMAL_STALE_SECONDS
  const frames = [older, newer].filter((f): f is NonNullable<typeof f> => !!f).sort((a, b) => b.ts - a.ts)
  const room = frames[0] ?? stored.data ?? null
  return {
    zonesC: { left: stale ? EMPTY : reading.left, right: stale ? EMPTY : reading.right },
    stale,
    ambientC: room?.ambientTemp ?? null,
    humidity: room?.humidity ?? null,
    ts: reading?.ts ?? null,
  }
}

const toZonesF = (zones: Zones) => zones.map(c => c == null ? null : toF(c)) as [number | null, number | null, number | null]

/** A readout in the header card: mono label over a light 20px value. */
function Readout({ label, value, testId }: { label: string, value: string, testId: string }) {
  return (
    <div className="flex flex-col gap-0.5 font-mono">
      <span className="text-[10px] uppercase tracking-[0.14em] text-[#8b8b92]">{label}</span>
      <span className="text-[20px] font-light leading-none tabular-nums" data-testid={testId}>{value}</span>
    </div>
  )
}

/**
 * Temperature stage: a full-screen 3D bed with per-side temperature, zone readouts, a
 * side panel and a schedule timeline. Same device wiring as TempScreen (device status,
 * setTemperature / setPower, schedules, surface sensors); the canvas is decorative and
 * every readout and action also exists as DOM text and keyboard.
 */
export function TempStage({ onExit }: { onExit: () => void }) {
  const { isLinked, toggleLink } = useSide()
  const { control: controlStyle, tempDisplay: display } = usePrefs()
  const { sideName } = useSideNames()
  const { status, isLoading: statusLoading, refetch } = useDeviceStatus()
  const { data: settings } = trpc.settings.getAll.useQuery({})
  const timeFormat = useTimeFormat()
  const unit: TempUnit = (settings?.device?.temperatureUnit as TempUnit) ?? 'F'
  const { data: occupancy } = trpc.biometrics.getOccupancy.useQuery(undefined, { refetchInterval: 30_000 })
  const [zoneMode] = useStageZones()
  const [autoReturn] = useStageAutoReturn()
  const [holdMinutes, setHoldMinutes] = useState(30)
  const controls = {
    left: useSideTemperature('left', status?.leftSide, holdMinutes, refetch),
    right: useSideTemperature('right', status?.rightSide, holdMinutes, refetch),
  }
  const refetchStatus = () => {
    void refetch()
  }
  // Pump stall, priming and alarm banners; a notice's blocksSides pauses that side's controls.
  const { notices, blocked } = useTempNotices(status, refetchStatus)
  const surface = useBedSurface()
  const now = useNow()
  const nowMs = now.getTime()
  const win = useMemo(() => stageWindow(now), [now])
  const schedules = {
    left: trpc.schedules.getAll.useQuery({ side: 'left' }, { staleTime: 60_000 }),
    right: trpc.schedules.getAll.useQuery({ side: 'right' }, { staleTime: 60_000 }),
  }
  const curves = useMemo(() => stageCurves({ left: schedules.left.data?.temperature, right: schedules.right.data?.temperature }, win), [schedules.left.data, schedules.right.data, win])
  // The Temp screen timeline's power and in-bed rows, on tonight's window.
  const recordsFrom = new Date(win.start - 12 * HOUR)
  const records = {
    left: trpc.biometrics.getSleepRecords.useQuery({ side: 'left', startDate: recordsFrom, limit: 10 }, { staleTime: 60_000, refetchInterval: 5 * 60_000 }),
    right: trpc.biometrics.getSleepRecords.useQuery({ side: 'right', startDate: recordsFrom, limit: 10 }, { staleTime: 60_000, refetchInterval: 5 * 60_000 }),
  }
  const history = trpc.health.thermalHistory.useQuery({ range: '24h' }, { staleTime: 60_000, refetchInterval: 60_000 })
  const activity: StageActivity | undefined = records.left.data || records.right.data || history.data
    ? {
        left: sideActivity({ curve: curves.left, records: records.left.data, history: history.data, side: 'left', win, now: nowMs }),
        right: sideActivity({ curve: curves.right, records: records.right.data, history: history.data, side: 'right', win, now: nowMs }),
      }
    : undefined
  const isStepper = controlStyle === 'stepper'
  const nightPhases = {
    left: useNightPhases('left', now, unit, display, isStepper),
    right: useNightPhases('right', now, unit, display, isStepper),
  }

  const [selected, setSelected] = useState<StageSide | null>(null)
  const [hover, setHover] = useState<StageSide | null>(null)
  const [previewAt, setPreviewAt] = useState<number | null>(null)
  const [mode, setMode] = useState<StageMode>('loading')
  const [stepperTab, setStepperTab] = useState<Record<StageSide, StepperTab>>({ left: 'now', right: 'now' })
  const canvas = useRef<StageCanvasHandle>(null)
  const labelRefs = useRef<StageLabelRefs>({ side: { left: null, right: null }, linked: null, zones: { left: [null, null, null], right: [null, null, null] } })
  const labels = useCallback(() => labelRefs.current, [])

  const names = { left: sideName('left'), right: sideName('right') }
  // A side a notice blocks (priming, its pump stall) takes no changes, even mirrored ones.
  const targetsFor = (side: StageSide): StageSide[] => (isLinked ? STAGE_SIDES : [side]).filter(s => !blocked[s])
  const previewing = previewAt != null

  const handlePreview = (side: StageSide, f: number) => {
    for (const s of targetsFor(side)) controls[s].preview(f)
  }
  const handleCommit = (side: StageSide, f: number) => {
    for (const s of targetsFor(side)) controls[s].commitTemp(f)
  }
  const handleStep = (side: StageSide, delta: number) => {
    if (!controls[side].isOn) return
    const f = stepForDisplay(controls[side].targetF, delta, unit, display)
    for (const s of targetsFor(side)) controls[s].stepTemp(f)
  }
  const handlePower = (side: StageSide) => {
    const next = !controls[side].isOn
    for (const s of targetsFor(side)) controls[s].commitPower(next)
  }
  const anyOn = STAGE_SIDES.some(s => controls[s].isOn)
  const handleAllOff = () => {
    for (const s of STAGE_SIDES) if (controls[s].isOn) controls[s].commitPower(false)
  }
  /** Linking copies the left side's target and power to the right, then mirrors every change. */
  const handleLink = () => {
    if (!isLinked) {
      if (controls.right.isOn !== controls.left.isOn) controls.right.commitPower(controls.left.isOn)
      if (controls.left.isOn && controls.right.targetF !== controls.left.targetF) controls.right.commitTemp(controls.left.targetF)
    }
    toggleLink()
  }
  const handleSelect = (side: StageSide) => setSelected(current => current === side ? null : side)
  /** A drag on the bed turns the side on and previews the target under the pointer. */
  const handleDrag = (side: StageSide, f: number) => {
    for (const s of targetsFor(side)) {
      if (!controls[s].isOn) controls[s].commitPower(true)
      controls[s].preview(f)
    }
  }
  const handleTabChange = (side: StageSide, tab: StepperTab) => {
    setStepperTab(prev => ({ ...prev, ...Object.fromEntries(targetsFor(side).map(s => [s, tab])) }))
  }
  const handleStepPhase = (side: StageSide, phase: NightPhaseKey, delta: number) => {
    for (const s of targetsFor(side)) nightPhases[s].nudge(phase, delta)
  }

  // Keys: 1/2 select, L link, ↑/↓ ±1° on the selection, ←/→ orbit, space power, v cards,
  // esc leaves the preview, then the selection, then the stage for the cards.
  const keys = useRef<(event: KeyboardEvent) => boolean>(() => false)
  const onStageKey = (event: KeyboardEvent): boolean => {
    switch (event.key) {
      case '1':
        setSelected(s => s === 'left' ? null : 'left')
        return true
      case '2':
        setSelected(s => s === 'right' ? null : 'right')
        return true
      case 'l':
      case 'L':
        handleLink()
        return true
      case 'ArrowUp':
      case 'ArrowDown':
        if (selected) handleStep(selected, event.key === 'ArrowUp' ? 1 : -1)
        return true
      case 'ArrowLeft':
      case 'ArrowRight':
        canvas.current?.orbitBy(event.key === 'ArrowLeft' ? -CAMERA.orbitStep : CAMERA.orbitStep)
        return true
      case ' ':
        if (selected) handlePower(selected)
        return true
      case 'v':
      case 'V':
        onExit()
        return true
      case 'Escape':
        if (previewAt != null) setPreviewAt(null)
        else if (selected) setSelected(null)
        else onExit()
        return true
      default:
        return false
    }
  }
  useLayoutEffect(() => {
    keys.current = onStageKey
  })
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (target && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName))) return
      if (keys.current(event)) event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const zonesF = { left: toZonesF(surface.zonesC.left), right: toZonesF(surface.zonesC.right) }
  const scheduled = (side: StageSide) => previewAt == null ? undefined : scheduledAt(curves, side, previewAt)
  /** What the surface measures: the controller's reading, else the mean of the zones. */
  const measuredF = (side: StageSide): number | null => controls[side].bedF ?? mean(zonesF[side])
  /** The colour a half wears: the schedule while previewing, otherwise the measured bed (both halves alike when linked). */
  const heatF = (side: StageSide): number | null => {
    if (previewAt != null) return scheduled(side) ?? null
    return isLinked ? mean([measuredF('left'), measuredF('right')]) : measuredF(side)
  }
  /** The label's number: scheduled while previewing, the target while on, the measured bed while off. */
  const labelF = (side: StageSide): number | null => {
    if (previewAt != null) return scheduled(side) ?? null
    return controls[side].isOn ? controls[side].targetF : measuredF(side)
  }
  const labelColor = (side: StageSide) => previewAt != null || controls[side].isOn ? tempColor(labelF(side)) : STAGE.text
  const statusOf = (side: StageSide) => blocked[side] && previewAt == null
    ? { word: 'OFF' as const, text: 'PAUSED', color: STAGE.text2 }
    : sideStatus({ on: controls[side].isOn, targetF: controls[side].targetF, bedF: controls[side].bedF }, unit, display, scheduled(side))
  const inBed = (side: StageSide) => occupancy?.[side]?.occupied ?? false
  const presenceFor = (side: StageSide): Presence => {
    const occ = occupancy?.[side]
    if (!occ) return null
    return occ.occupied ? 'in' : occ.available ? 'out' : null
  }

  const litAt = new Date(previewAt ?? nowMs)
  const sceneState: StageSceneState = {
    sides: {
      left: { shownF: heatF('left'), zonesF: zonesF.left, targetF: controls.left.targetF },
      right: { shownF: heatF('right'), zonesF: zonesF.right, targetF: controls.right.targetF },
    },
    selected,
    linked: isLinked,
    zones: zoneMode,
    previewing,
    autoReturn: autoReturn === 'true',
    hour: litAt.getHours() + litAt.getMinutes() / 60,
  }

  const panelSide = selected ?? 'left'
  const panelName = isLinked ? 'Both sides' : names[panelSide]
  const panelScope = isLinked
    ? `${names.left} · ${names.right} · Linked`
    : [panelSide === 'left' ? 'Left' : 'Right', settings?.sides?.[panelSide]?.awayMode ? 'Away' : presenceFor(panelSide) === 'in' ? 'In bed' : presenceFor(panelSide) === 'out' ? 'Out of bed' : null].filter(Boolean).join(' · ')
  const roomText = formatSensorC(surface.ambientC, unit, { includeUnit: false, nullDisplay: '—' })
  const humidityText = surface.humidity == null ? '—' : `${Math.round(surface.humidity)}%`
  const bedAirText = formatSensorC(mean([...surface.zonesC.left, ...surface.zonesC.right]), unit, { decimals: 1, includeUnit: false, nullDisplay: '—' })

  return (
    <div
      data-testid="temp-stage"
      className="fixed inset-0 z-30 select-none overflow-hidden bg-[#0b0b0c] font-sans text-[#ececec] min-[900px]:left-[224px] max-[899px]:bottom-[calc(60px+env(safe-area-inset-bottom,0px))]"
    >
      {mode !== '2d' && (
        <StageCanvas
          ref={canvas}
          state={sceneState}
          labels={labels}
          onMode={setMode}
          callbacks={{ onHover: setHover, onSelect: handleSelect, onDrag: handleDrag, onDragEnd: handleCommit, onNudge: handleStep }}
        />
      )}
      {mode === 'loading' && (
        <div role="status" data-testid="stage-loading" className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[12px] uppercase tracking-[0.12em] text-[#5d5d63]">
          Loading stage…
        </div>
      )}

      {/* Projected labels: the scene positions them; they are the accessible readouts. */}
      {mode !== '2d' && (
        <div className={cn('pointer-events-none absolute inset-0 transition-opacity duration-300', mode === '3d' ? 'opacity-100' : 'opacity-0')} data-testid="stage-labels">
          {STAGE_SIDES.map(side => (
            <SideLabel
              key={side}
              ref={el => void (labelRefs.current.side[side] = el)}
              testId={`stage-label-${side}`}
              name={names[side]}
              temperature={formatStageTemp(labelF(side), unit, display)}
              color={labelColor(side)}
              status={statusOf(side)}
              inBed={inBed(side)}
              selected={selected === side}
              hovered={hover === side}
              hidden={isLinked}
            />
          ))}
          <SideLabel
            ref={el => void (labelRefs.current.linked = el)}
            testId="stage-label-linked"
            name={`${names.left} · ${names.right}`}
            temperature={formatStageTemp(labelF('left'), unit, display)}
            color={labelColor('left')}
            status={statusOf('left')}
            inBed={inBed('left') || inBed('right')}
            selected={selected != null}
            hovered={hover != null}
            hidden={!isLinked}
          />
          {STAGE_SIDES.map(side => ZONE_NAMES.map((zone, index) => (
            <ZoneLabel
              key={`${side}-${zone}`}
              ref={el => void (labelRefs.current.zones[side][index] = el)}
              testId={`stage-zone-${side}-${zone.toLowerCase()}`}
              zone={zone}
              value={formatSensorC(surface.zonesC[side][index], unit, { decimals: 1, includeUnit: false })}
              color={tempColor(zonesF[side][index])}
            />
          )))}
        </div>
      )}

      {/* Live indicator · view switch · link and power, top centre, wrapping on phones;
          the pod's alarm, priming and pump notices sit underneath. */}
      <div className="pointer-events-none absolute inset-x-4 top-6 z-20 flex flex-col items-center gap-3">
        <div className="flex flex-wrap items-center justify-center gap-2 whitespace-nowrap *:pointer-events-auto">
          {previewing
            ? (
                <button type="button" onClick={() => setPreviewAt(null)} data-testid="stage-mode" className={cn(PILL, 'font-mono text-[11px] uppercase tracking-[0.12em]')} style={{ ...GLASS, color: STAGE.preview, borderColor: STAGE.preview }}>
                  <span aria-hidden className="size-1.5 rounded-full" style={{ background: STAGE.preview }} />
                  {`Preview · ${clock(previewAt, timeFormat)} · Back to live`}
                </button>
              )
            : (
                <span data-testid="stage-mode" className={cn(PILL, 'cursor-default font-mono text-[11px] uppercase tracking-[0.12em]')} style={{ ...GLASS, color: statusLoading ? STAGE.text2 : STAGE.live, borderColor: STAGE.line2 }}>
                  <span aria-hidden className="size-1.5 rounded-full" style={{ background: statusLoading ? STAGE.text3 : STAGE.live }} />
                  {statusLoading ? 'Connecting' : 'Live'}
                </span>
              )}
          <ViewSwitch view="stage" onChange={v => v === 'cards' && onExit()} />
          <button
            type="button"
            aria-pressed={isLinked}
            onClick={handleLink}
            className={cn(PILL, isLinked ? 'border-[#ececec] bg-[#ececec] text-[#0b0b0c]' : 'border-[#26262a] text-[#b0b0b6] hover:bg-[#17171a]')}
            style={isLinked ? undefined : GLASS}
          >
            <Link2 size={14} />
            {isLinked ? 'Linked' : 'Link sides'}
          </button>
          <button type="button" onClick={handleAllOff} disabled={!anyOn} className={cn(PILL, 'border-[#26262a] text-[#b0b0b6] hover:bg-[#17171a]')} style={GLASS}>
            <Power size={14} />
            All off
          </button>
        </div>
        <div data-testid="stage-alerts" className="pointer-events-auto flex w-full max-w-[560px] flex-col gap-2 rounded-card border p-2 empty:hidden min-[1200px]:mt-8" style={{ ...GLASS, borderColor: STAGE.line }}>
          <NoticeStack notices={notices} />
        </div>
      </div>

      {/* Room readouts, top right, once there is room beside the centred pills. */}
      <div className="absolute right-7 top-6 z-10 hidden gap-7 rounded-xl border px-[18px] py-3 min-[1200px]:flex" style={{ ...GLASS, borderColor: STAGE.line }}>
        <Readout label="Room" value={roomText} testId="stage-room" />
        <Readout label="Humidity" value={humidityText} testId="stage-humidity" />
        <Readout label="Bed air" value={bedAirText} testId="stage-bed-air" />
      </div>

      {mode === '2d' && (
        <div className="absolute inset-x-7 top-[104px] bottom-[232px] flex flex-col items-center gap-4 overflow-y-auto" data-testid="stage-fallback">
          <span className="font-mono text-[12px] uppercase tracking-[0.12em] text-[#5d5d63]">3D view could not load</span>
          <div className="grid w-full max-w-[760px] gap-4 min-[700px]:grid-cols-2">
            {STAGE_SIDES.map((side) => {
              const c = controls[side]
              return (
                <SideCard
                  key={side}
                  side={side}
                  name={names[side]}
                  presence={presenceFor(side)}
                  away={Boolean(settings?.sides?.[side]?.awayMode)}
                  control={status?.temperatureControl?.[side]}
                  variant={controlStyle}
                  display={display}
                  unit={unit}
                  targetF={c.targetF}
                  bedF={c.bedF}
                  isOn={c.isOn}
                  paused={blocked[side]}
                  stepDisabled={!c.isOn || c.tempPending || blocked[side]}
                  powerDisabled={c.powerPending || blocked[side]}
                  holdMinutes={holdMinutes}
                  onHoldChange={setHoldMinutes}
                  onPreview={f => handlePreview(side, f)}
                  onCommit={f => handleCommit(side, f)}
                  onStep={delta => handleStep(side, delta)}
                  onPower={() => handlePower(side)}
                  onResumed={() => { void refetch() }}
                  stepper={isStepper
                    ? { tab: stepperTab[side], onTabChange: tab => handleTabChange(side, tab), schedule: nightPhases[side], onStepPhase: (phase, delta) => handleStepPhase(side, phase, delta), now }
                    : undefined}
                />
              )
            })}
          </div>
        </div>
      )}

      <StagePanel
        open={selected != null}
        side={panelSide}
        name={panelName}
        scope={panelScope}
        isOn={controls[panelSide].isOn}
        powerDisabled={controls[panelSide].powerPending || blocked[panelSide]}
        onPower={() => handlePower(panelSide)}
        onClose={() => setSelected(null)}
        status={statusOf(panelSide)}
        control={status?.temperatureControl?.[panelSide]}
        onResumed={() => { void refetch() }}
        controlStyle={controlStyle}
        display={display}
        unit={unit}
        targetF={controls[panelSide].targetF}
        bedF={controls[panelSide].bedF}
        stepDisabled={!controls[panelSide].isOn || controls[panelSide].tempPending || blocked[panelSide]}
        onPreview={f => handlePreview(panelSide, f)}
        onCommit={f => handleCommit(panelSide, f)}
        onStep={delta => handleStep(panelSide, delta)}
        holdMinutes={holdMinutes}
        onHoldChange={setHoldMinutes}
        stepper={{ tab: stepperTab[panelSide], onTabChange: tab => handleTabChange(panelSide, tab), schedule: nightPhases[panelSide], onStepPhase: (phase, delta) => handleStepPhase(panelSide, phase, delta), now }}
      />

      <div className="absolute inset-x-7 bottom-[60px] z-10 max-[899px]:inset-x-3 max-[899px]:bottom-3">
        <StageTimeline
          win={win}
          now={nowMs}
          curves={curves}
          activity={activity}
          names={names}
          unit={unit}
          display={display}
          previewAt={previewAt}
          onScrub={setPreviewAt}
          loading={schedules.left.isLoading || schedules.right.isLoading}
        />
      </div>
      <div className="pointer-events-none absolute inset-x-7 bottom-5 hidden h-6 items-center gap-[22px] overflow-hidden whitespace-nowrap font-mono text-[11px] text-[#5d5d63] min-[900px]:flex" aria-hidden data-testid="stage-hints">
        {KEY_HINTS.map(([key, label]) => (
          <span key={key} className="flex items-center gap-[7px]">
            <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded border px-[5px] text-[10px] text-[#8b8b92]" style={{ borderColor: STAGE.frame }}>{key}</span>
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}
