'use client'

import type { PointerEvent } from 'react'
import { dropHolds, stepPath } from '@/src/components/Schedule/CurveChart'
import type { TempUnit } from '@/src/lib/tempUtils'
import { useTimeFormat } from '@/src/providers/TimeFormatProvider'
import type { TempDisplay } from '@/src/providers/PrefsProvider'
import { STAGE, STAGE_SIDES, formatStageTemp } from './stageColors'
import type { StageSide } from './stageColors'
import { clock, fractionOf, formatUntil, hourLabel, nextChange, stageRange, stageTicks, timeAtFraction } from './stageTimelineLogic'
import type { StageCurves, StageWindow } from './stageTimelineLogic'

const VB_W = 1000
const LANE_H = 84
const CURVE_COLOR: Record<StageSide, string> = { left: STAGE.text, right: '#6f6f76' }

export interface StageTimelineProps {
  win: StageWindow
  now: number
  curves: StageCurves
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
 * Tonight, 6 PM to 9 AM, as a floating card: a legend, both schedule curves (left
 * white, right grey), a now marker, and a scrub anywhere on the lane that previews
 * the bed at that hour. The preview stays until Back to live.
 */
export function StageTimeline({ win, now, curves, names, unit, display, previewAt, onScrub, loading }: StageTimelineProps) {
  const timeFormat = useTimeFormat()
  const range = stageRange(curves)
  const ticks = stageTicks(win)
  const next = nextChange(curves, now)
  const pct = (t: number) => `${(fractionOf(win, t) * 100).toFixed(2)}%`
  const X = (t: number) => fractionOf(win, t) * VB_W

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
      <div className="flex items-center gap-4 font-mono text-[11px] uppercase tracking-[0.12em] text-[#8b8b92]">
        <span>Tonight</span>
        {STAGE_SIDES.map(side => (
          <span key={side} className="flex items-center gap-1.5">
            <span aria-hidden className="h-0.5 w-3.5" style={{ background: CURVE_COLOR[side] }} />
            {names[side]}
          </span>
        ))}
        {!range && !loading && <span className="tracking-normal text-[#5d5d63]">no schedule</span>}
        {next && (
          <span className="normal-case tracking-normal text-[#5d5d63]" data-testid="stage-next">
            {`next · ${names[next.side]} ${formatStageTemp(next.temperatureF, unit, display)} in ${formatUntil(next.at - now)}`}
          </span>
        )}
        <span className="ml-auto hidden tracking-[0.06em] text-[#5d5d63] min-[900px]:inline">Drag the timeline to preview</span>
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
        className="relative cursor-ew-resize touch-none select-none"
        style={{ height: LANE_H }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
      >
        <svg viewBox={`0 0 ${VB_W} ${LANE_H}`} preserveAspectRatio="none" className="absolute inset-0 block size-full overflow-visible" aria-hidden>
          {[1, 2, 3].map(i => <line key={i} x1="0" x2={VB_W} y1={LANE_H / 4 * i} y2={LANE_H / 4 * i} stroke="#1a1a1d" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
          {range && STAGE_SIDES.map((side) => {
            const pts = dropHolds(curves[side])
            if (pts.length < 2) return null
            const coords = pts.map(p => ({ x: X(p.at), y: yOf(p.temperature, range) }))
            return <path key={side} data-testid={`stage-curve-${side}`} d={stepPath(coords)} fill="none" stroke={CURVE_COLOR[side]} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          })}
        </svg>
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
      <div className="flex justify-between font-mono text-[10px] text-[#5d5d63]" aria-hidden>
        {ticks.map(t => <span key={t}>{hourLabel(t, timeFormat)}</span>)}
      </div>
    </div>
  )
}
