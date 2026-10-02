'use client'

import { useCallback, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { TEMP, tempFToOffset } from '@/src/lib/tempColors'
import { setpointFToDisplay, type TempUnit } from '@/src/lib/tempUtils'
import { formatLevel } from '@/src/components/TempScreen/nightPhases'
import type { TempDisplay } from '@/src/providers/PrefsProvider'

const W = 280
const H = 250
const R = 120
const C = 140
const START = 135
const SWEEP = 270
const ARC_LEN = 2 * Math.PI * R * (SWEEP / 360) // ≈ 565.5
const FULL_LEN = 2 * Math.PI * R // ≈ 754

export type TempDirection = 'cool' | 'warm' | 'hold'

/** Accent rule: target < bed → cool, target > bed → warm, equal → hold. */
export function directionFor(targetF: number, bedF: number | null | undefined): TempDirection {
  if (bedF == null || !Number.isFinite(bedF)) return 'hold'
  const t = Math.round(targetF)
  const b = Math.round(bedF)
  return t < b ? 'cool' : t > b ? 'warm' : 'hold'
}

export const ACCENT_VAR: Record<TempDirection, string> = {
  cool: 'var(--accent-cool)',
  warm: 'var(--accent-warm)',
  hold: 'var(--accent-neutral)',
}

const STATUS_WORD: Record<TempDirection, string> = {
  cool: 'COOLING',
  warm: 'WARMING',
  hold: 'HOLDING',
}

function clampF(v: number) {
  return Math.max(TEMP.MIN_F, Math.min(TEMP.MAX_F, v))
}

function fraction(f: number) {
  return (clampF(f) - TEMP.MIN_F) / (TEMP.MAX_F - TEMP.MIN_F)
}

/** "+3" · "−4" · "0" — offset from 80°F in whole °F steps, as on the old dial. */
export function formatOffset(f: number): string {
  const o = tempFToOffset(Math.round(f))
  return o > 0 ? `+${o}` : o < 0 ? `−${-o}` : '0'
}

export interface TempControlProps {
  variant?: 'dial' | 'slider'
  /** Big number as degrees, or as the ± offset from 80°F. */
  display?: TempDisplay
  /** Target set point in °F (canonical). */
  targetF: number
  /** Current bed temperature in °F, if known. */
  bedF?: number | null
  unit?: TempUnit
  /** Side powered on. Off renders at 35% opacity and disables drag. */
  power?: boolean
  /** Called while dragging with a whole-degree °F value. */
  onChange?: (f: number) => void
  /** Called on drag release with the final °F value. */
  onCommit?: (f: number) => void
  /** Status word override (e.g. "OFF"). */
  statusOverride?: string
  className?: string
}

/**
 * Swappable temperature control. Both variants occupy 280×250 so switching
 * between dial and slider never moves the surrounding layout.
 */
export function TempControl({
  variant = 'dial',
  display: displayMode = 'degrees',
  targetF,
  bedF,
  unit = 'F',
  power = true,
  onChange,
  onCommit,
  statusOverride,
  className,
}: TempControlProps) {
  const [dragF, setDragF] = useState<number | null>(null)
  const dragRef = useRef<number | null>(null)
  const shownF = dragF ?? targetF
  const f = fraction(shownF)
  const dir = directionFor(shownF, bedF)
  const accent = ACCENT_VAR[dir]
  const interactive = power && !!(onChange || onCommit)

  const display = Math.round(setpointFToDisplay(shownF, unit) ?? shownF)
  const bedDisplay = bedF != null && Number.isFinite(bedF) ? Math.round(setpointFToDisplay(bedF, unit) ?? bedF) : null
  const delta = bedDisplay != null ? display - bedDisplay : null
  const offsetMode = displayMode !== 'degrees'
  const relative = displayMode === 'level' ? formatLevel : formatOffset
  const sub = offsetMode
    ? `${display}°${unit} · bed ${bedDisplay == null ? '—' : `${bedDisplay}°${unit}`}`
    : delta == null
      ? 'bed —'
      : `${delta > 0 ? '+' : delta < 0 ? '−' : '±'}${Math.abs(delta)} · bed ${bedDisplay}°${unit}`
  const status = statusOverride ?? STATUS_WORD[dir]
  // Scale marks read in the same terms as the big number.
  const mark = (f: number) => (offsetMode ? relative(f) : `${Math.round(setpointFToDisplay(f, unit) ?? f)}°`)

  const numeral = (
    <div className="font-mono text-[64px] font-light leading-none" aria-live="polite" data-testid="temp-numeral">
      {offsetMode ? relative(shownF) : `${display}°`}
    </div>
  )
  const subEl = <div className="font-mono text-[13px] text-fg-2">{sub}</div>
  const statusEl = <div className="sp-status" style={{ color: statusOverride ? 'var(--text-2)' : accent }}>{status}</div>

  const setFromFraction = useCallback((frac: number) => {
    const next = clampF(Math.round(TEMP.MIN_F + Math.max(0, Math.min(1, frac)) * (TEMP.MAX_F - TEMP.MIN_F)))
    if (next !== dragRef.current) {
      dragRef.current = next
      setDragF(next)
      onChange?.(next)
    }
  }, [onChange])

  const endDrag = useCallback(() => {
    const v = dragRef.current
    dragRef.current = null
    setDragF(null)
    if (v != null) onCommit?.(v)
  }, [onCommit])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!interactive) return
    let next: number | null = null
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = clampF(Math.round(targetF) + 1)
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = clampF(Math.round(targetF) - 1)
    if (next == null) return
    e.preventDefault()
    onChange?.(next)
    onCommit?.(next)
  }

  const a11y = {
    'role': 'slider',
    'tabIndex': interactive ? 0 : -1,
    'aria-label': 'Target temperature',
    'aria-valuemin': Math.round(setpointFToDisplay(TEMP.MIN_F, unit) ?? TEMP.MIN_F),
    'aria-valuemax': Math.round(setpointFToDisplay(TEMP.MAX_F, unit) ?? TEMP.MAX_F),
    'aria-valuenow': display,
    'aria-valuetext': offsetMode
      ? `${relative(shownF)} (${display}°${unit}), ${status.toLowerCase()}`
      : `${display}°${unit}, ${status.toLowerCase()}`,
    'aria-disabled': !interactive,
    'onKeyDown': onKeyDown,
  } as const

  if (variant === 'slider') {
    const midPct = fraction(TEMP.BASE_F) * 100

    const fromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect()
      setFromFraction(1 - (e.clientY - rect.top) / rect.height)
    }

    return (
      <div data-no-swipe className={cn('flex gap-3.5', !power && 'opacity-35', className)} style={{ width: W, height: H }}>
        <div
          {...a11y}
          className={cn('relative w-[76px] shrink-0 touch-none overflow-hidden rounded-[38px] bg-track outline-none focus-visible:ring-2 focus-visible:ring-fg-3', interactive && 'cursor-ns-resize')}
          onPointerDown={(e) => {
            if (!interactive) return
            e.currentTarget.setPointerCapture(e.pointerId)
            fromPointer(e)
          }}
          onPointerMove={(e) => {
            if (dragRef.current == null) return
            fromPointer(e)
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className="absolute inset-x-0 bottom-0" style={{ height: `${f * 100}%`, background: accent }} />
          <div className="absolute inset-x-[22px] h-1 rounded-sm bg-app" style={{ bottom: `calc(${f * 100}% - 16px)` }} />
        </div>
        <div className="relative w-[34px] font-mono text-[11px] text-fg-2">
          <span className="absolute top-0">{mark(TEMP.MAX_F)}</span>
          <span className="absolute" style={{ bottom: `calc(${midPct}% - 7px)` }}>{mark(TEMP.BASE_F)}</span>
          <span className="absolute bottom-0">{mark(TEMP.MIN_F)}</span>
        </div>
        <div className="flex min-w-0 flex-col justify-center gap-1.5">
          {statusEl}
          {numeral}
          {subEl}
        </div>
      </div>
    )
  }

  const th = ((START + SWEEP * f) * Math.PI) / 180
  const kx = C + R * Math.cos(th)
  const ky = C + R * Math.sin(th)

  const fromDialPointer = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const scale = rect.width / W
    const x = (e.clientX - rect.left) / scale - C
    const y = (e.clientY - rect.top) / scale - C
    let deg = (Math.atan2(y, x) * 180) / Math.PI
    // Angle measured from the arc start (135°), wrapped to 0..360.
    let rel = (deg - START + 360) % 360
    if (rel > SWEEP) {
      // In the dead zone at the bottom: snap to the nearer end.
      rel = rel - SWEEP < (360 - SWEEP) / 2 ? SWEEP : 0
    }
    deg = rel
    setFromFraction(deg / SWEEP)
  }

  return (
    <div data-no-swipe className={cn('relative', !power && 'opacity-35', className)} style={{ width: W, height: H }}>
      <svg
        {...a11y}
        viewBox={`0 0 ${W} ${W}`}
        width={W}
        height={W}
        className={cn('absolute left-0 top-0 touch-none outline-none focus-visible:[&>circle:first-child]:stroke-fg-3', interactive && 'cursor-grab active:cursor-grabbing')}
        onPointerDown={(e) => {
          if (!interactive) return
          e.currentTarget.setPointerCapture(e.pointerId)
          fromDialPointer(e)
        }}
        onPointerMove={(e) => {
          if (dragRef.current == null) return
          fromDialPointer(e)
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <circle
          cx={C}
          cy={C}
          r={R}
          fill="none"
          stroke="var(--dial-track)"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${ARC_LEN.toFixed(1)} ${FULL_LEN.toFixed(0)}`}
          transform={`rotate(${START} ${C} ${C})`}
        />
        {/* Wide invisible stroke widens the drag target along the arc. */}
        <circle
          cx={C}
          cy={C}
          r={R}
          fill="none"
          stroke="transparent"
          strokeWidth="44"
          strokeDasharray={`${ARC_LEN.toFixed(1)} ${FULL_LEN.toFixed(0)}`}
          transform={`rotate(${START} ${C} ${C})`}
        />
        <circle
          cx={C}
          cy={C}
          r={R}
          fill="none"
          stroke={accent}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${(ARC_LEN * f).toFixed(1)} ${FULL_LEN.toFixed(0)}`}
          transform={`rotate(${START} ${C} ${C})`}
        />
        <circle cx={kx.toFixed(1)} cy={ky.toFixed(1)} r="9" fill="var(--text-1)" />
      </svg>
      <div className="pointer-events-none absolute inset-x-0 top-[84px] flex flex-col items-center gap-1.5">
        {numeral}
        {subEl}
        {statusEl}
      </div>
    </div>
  )
}
