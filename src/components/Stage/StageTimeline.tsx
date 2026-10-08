'use client'

import { useId } from 'react'
import type { PointerEvent } from 'react'
import { dropHolds, stepPath } from '@/src/components/Schedule/CurveChart'
import { NEUTRAL_TEMP_F, tempTone } from '@/src/components/Schedule/scheduleFormat'
import type { TempTone } from '@/src/components/Schedule/scheduleFormat'
import type { Interval } from '@/src/components/TempScreen/timelineLogic'
import type { TempUnit } from '@/src/lib/tempUtils'
import { useTimeFormat } from '@/src/providers/TimeFormatProvider'
import type { TempDisplay } from '@/src/providers/PrefsProvider'
import { STAGE, STAGE_SIDES, formatStageTemp } from './stageColors'
import type { StageSide } from './stageColors'
import { clock, fractionOf, formatUntil, hourLabel, nextChange, stageRange, stageTicks, timeAtFraction } from './stageTimelineLogic'
import type { StageActivity, StageCurves, StageWindow } from './stageTimelineLogic'

const VB_W = 1000
const LANE_H = 60
const ROW_H = 14
/** Same tones as the Temp screen timeline: below 80°F cools, above warms. */
const TONE_COLOR: Record<TempTone, string> = { cool: STAGE.cooling, warm: STAGE.warming, neutral: STAGE.text }
/** Both curves wear the tone ramp, so the right side is told apart by its dash. */
const DASH: Record<StageSide, string | undefined> = { left: undefined, right: '5 4' }
const POWER_COLOR = '#55555c'
const MISMATCH_COLOR = STAGE.preview

export interface StageTimelineProps {
  win: StageWindow
  now: number
  curves: StageCurves
  /** Powered and in-bed stretches per side; rows are left out until it loads. */
  activity?: StageActivity
  names: Record<StageSide, string>
  unit: TempUnit
  display: TempDisplay
  /** The moment being previewed, or null while live. */
  previewAt: number | null
  onScrub: (t: number) => void
  loading?: boolean
}

function yOf(temperature: number, range: { lo: number, hi: number }): number {
  const pad = 8
  return pad + (1 - (temperature - range.lo) / (range.hi - range.lo)) * (LANE_H - pad * 2)
}

/**
 * Tonight, 6 PM to 9 AM, as a floating card: a legend, both schedule curves coloured
 * by tone (left solid, right dashed) with the next set point marked, each side's
 * powered and in-bed stretches with schedule mismatches bracketed, a now marker, and
 * a scrub anywhere on the lane that previews the bed at that hour. The preview stays
 * until Back to live.
 */
export function StageTimeline({ win, now, curves, activity, names, unit, display, previewAt, onScrub, loading }: StageTimelineProps) {
  const timeFormat = useTimeFormat()
  const gradientId = `stage-tl-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const range = stageRange(curves)
  const ticks = stageTicks(win)
  const next = nextChange(curves, now)
  const pct = (t: number) => `${(fractionOf(win, t) * 100).toFixed(2)}%`
  const width = (iv: Interval) => `${((fractionOf(win, iv.end) - fractionOf(win, iv.start)) * 100).toFixed(2)}%`
  const X = (t: number) => fractionOf(win, t) * VB_W
  const temps = [...curves.left, ...curves.right].map(p => p.temperature)
  const hi = temps.length ? Math.max(...temps) : null
  const lo = temps.length ? Math.min(...temps) : null
  const neutralY = range && NEUTRAL_TEMP_F > range.lo && NEUTRAL_TEMP_F < range.hi ? yOf(NEUTRAL_TEMP_F, range) : null

  const scrubFrom = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (!rect.width) return
    onScrub(timeAtFraction(win, (event.clientX - rect.left) / rect.width))
  }
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    scrubFrom(event)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.buttons & 1) scrubFrom(event)
  }

  return (
    <div
      className="flex flex-col gap-2.5 rounded-[14px] border px-5 pt-4 pb-3"
      style={{ borderColor: STAGE.line, background: 'rgba(11,11,12,0.72)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)' }}
      data-testid="stage-timeline"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] uppercase tracking-[0.12em] text-[#8b8b92]">
        <span>Tonight</span>
        {STAGE_SIDES.map(side => (
          <span key={side} className="flex items-center gap-1.5">
            <svg aria-hidden width="16" height="2" className="block">
              <line x1="0" x2="16" y1="1" y2="1" stroke={STAGE.text2} strokeWidth="2" strokeDasharray={side === 'right' ? '4 3' : undefined} />
            </svg>
            {names[side]}
          </span>
        ))}
        {activity && (
          <>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="h-[3px] w-3.5 rounded-full" style={{ background: POWER_COLOR }} />
              on
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="h-[3px] w-3.5 rounded-full" style={{ background: STAGE.live }} />
              in bed
            </span>
          </>
        )}
        {!range && !loading && <span className="tracking-normal text-[#5d5d63]">no schedule</span>}
        {next && (
          <span className="normal-case tracking-normal text-[#5d5d63]" data-testid="stage-next">
            {`next · ${names[next.side]} ${formatStageTemp(next.temperatureF, unit, display)} in ${formatUntil(next.at - now)}`}
          </span>
        )}
        <span className="ml-auto hidden tracking-[0.06em] text-[#5d5d63] min-[900px]:inline">Drag the timeline to preview</span>
      </div>
      <div className="flex gap-3">
        <div className="flex w-14 shrink-0 flex-col font-mono text-[10px] text-[#5d5d63]" aria-hidden>
          <div className="relative" style={{ height: LANE_H }} data-testid="stage-range">
            {range && hi != null && <span className="absolute right-0 -translate-y-1/2 leading-none" style={{ top: yOf(hi, range) }}>{formatStageTemp(hi, unit, display)}</span>}
            {range && lo != null && lo !== hi && <span className="absolute right-0 -translate-y-1/2 leading-none" style={{ top: yOf(lo, range) }}>{formatStageTemp(lo, unit, display)}</span>}
          </div>
          {activity && STAGE_SIDES.map(side => (
            <span key={side} className="truncate text-right leading-none" style={{ height: ROW_H, lineHeight: `${ROW_H}px` }}>{names[side]}</span>
          ))}
        </div>
        <div
          role="slider"
          aria-label="Preview tonight's schedule"
          aria-valuemin={win.start}
          aria-valuemax={win.end}
          aria-valuenow={previewAt ?? now}
          aria-valuetext={clock(previewAt ?? now, timeFormat)}
          tabIndex={-1}
          data-testid="stage-lane"
          className="relative min-w-0 flex-1 cursor-ew-resize touch-none select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
        >
          <div className="relative" style={{ height: LANE_H }}>
            <svg viewBox={`0 0 ${VB_W} ${LANE_H}`} preserveAspectRatio="none" className="absolute inset-0 block size-full overflow-visible" aria-hidden>
              {[1, 2, 3].map(i => <line key={i} x1="0" x2={VB_W} y1={LANE_H / 4 * i} y2={LANE_H / 4 * i} stroke="#1a1a1d" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
              {neutralY != null && <line x1="0" x2={VB_W} y1={neutralY} y2={neutralY} stroke="#2e2e33" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" data-testid="stage-neutral" />}
              {range && STAGE_SIDES.map((side) => {
                const pts = dropHolds(curves[side])
                if (pts.length < 2) return null
                const coords = pts.map(p => ({ x: X(p.at), y: yOf(p.temperature, range) }))
                const x0 = coords[0].x
                const x1 = coords[coords.length - 1].x
                const path = stepPath(coords)
                return (
                  <g key={side}>
                    <defs>
                      <linearGradient id={`${gradientId}-${side}`} x1={x0} y1="0" x2={x1} y2="0" gradientUnits="userSpaceOnUse">
                        {pts.map((p, j) => (
                          <stop key={j} offset={((coords[j].x - x0) / (x1 - x0 || 1)).toFixed(3)} stopColor={TONE_COLOR[tempTone(p.temperature)]} />
                        ))}
                      </linearGradient>
                    </defs>
                    <path d={`${path} L${x1},${LANE_H} L${x0},${LANE_H} Z`} fill={STAGE.text} fillOpacity="0.035" />
                    <path data-testid={`stage-curve-${side}`} d={path} fill="none" stroke={`url(#${gradientId}-${side})`} strokeWidth="1.5" strokeDasharray={DASH[side]} vectorEffect="non-scaling-stroke" />
                  </g>
                )
              })}
            </svg>
            {next && range && (
              <span
                aria-hidden
                data-testid="stage-next-dot"
                className="pointer-events-none absolute size-2.5 -translate-1/2 rounded-full border-2"
                style={{ left: pct(next.at), top: yOf(next.temperatureF, range), borderColor: TONE_COLOR[tempTone(next.temperatureF)], background: STAGE.app }}
              />
            )}
          </div>
          {activity && STAGE_SIDES.map(side => (
            <div key={side} className="relative" style={{ height: ROW_H }} data-testid={`stage-activity-${side}`}>
              <div className="absolute inset-x-0 top-[3px] h-[3px] rounded-full bg-[#1a1a1d]">
                {activity[side].power.map(iv => (
                  <span key={iv.start} title={`${names[side]} powered ${clock(iv.start, timeFormat)} → ${clock(iv.end, timeFormat)}`} className="absolute inset-y-0 min-w-0.5 rounded-full" style={{ left: pct(iv.start), width: width(iv), background: POWER_COLOR }} />
                ))}
              </div>
              <div className="absolute inset-x-0 top-[8px] h-[3px] rounded-full bg-[#1a1a1d]">
                {activity[side].presence.map(iv => (
                  <span key={iv.start} title={`${names[side]} in bed ${clock(iv.start, timeFormat)} → ${clock(iv.end, timeFormat)}`} className="absolute inset-y-0 min-w-0.5 rounded-full" style={{ left: pct(iv.start), width: width(iv), background: STAGE.live }} />
                ))}
              </div>
              {activity[side].mismatches.map(mm => (
                <span
                  key={mm.start}
                  title={`${names[side]}: ${mm.label}`}
                  data-testid={`stage-mismatch-${side}`}
                  className="absolute top-px h-[12px] rounded-[2px] border"
                  style={{ left: pct(mm.start), width: width(mm), borderColor: MISMATCH_COLOR }}
                >
                  <span className="sr-only">{`${names[side]}: ${mm.label}`}</span>
                </span>
              ))}
            </div>
          ))}
          <div aria-hidden data-testid="stage-now" className="pointer-events-none absolute inset-y-0 w-px" style={{ left: pct(now), background: STAGE.text2 }}>
            <span className="absolute -top-0.5 left-1.5 whitespace-nowrap font-mono text-[10px] leading-none" style={{ color: STAGE.text2 }}>{`now ${clock(now, timeFormat)}`}</span>
          </div>
          {previewAt != null && (
            <div aria-hidden data-testid="stage-preview-marker" className="pointer-events-none absolute inset-y-0 w-px" style={{ left: pct(previewAt), background: STAGE.preview }}>
              <span className="absolute -top-0.5 -translate-x-1/2 whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[10px] font-medium leading-none text-[#0b0b0c]" style={{ background: STAGE.preview }}>
                {clock(previewAt, timeFormat)}
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="flex gap-3" aria-hidden>
        <span className="w-14 shrink-0" />
        <div className="flex min-w-0 flex-1 justify-between font-mono text-[10px] text-[#5d5d63]">
          {ticks.map(t => <span key={t}>{hourLabel(t, timeFormat)}</span>)}
        </div>
      </div>
    </div>
  )
}
