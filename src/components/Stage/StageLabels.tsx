'use client'

import { forwardRef } from 'react'
import type { CSSProperties } from 'react'
import { STAGE } from './stageColors'
import type { SideStatus } from './stageColors'

/**
 * Labels float on their own compositing layer; the scene sets `transform` every frame
 * from a projected 3D point, so nothing here declares one.
 */
const LAYER: CSSProperties = { position: 'absolute', left: 0, top: 0, zIndex: 5, willChange: 'transform', pointerEvents: 'none' }

export interface SideLabelProps {
  name: string
  /** The big number, already formatted. */
  temperature: string
  /** Colour of the big number: the ramp while on or previewing, plain text while off. */
  color: string
  status: SideStatus
  inBed: boolean
  selected: boolean
  hovered: boolean
  hidden?: boolean
  testId: string
}

/** A side's pill (presence dot, name, temperature, activity ring), its status word and a short leader down to the bed. */
export const SideLabel = forwardRef<HTMLDivElement, SideLabelProps>(function SideLabel({ name, temperature, color, status, inBed, selected, hovered, hidden, testId }, ref) {
  const busy = status.word === 'COOLING' || status.word === 'WARMING'
  const border = selected ? STAGE.text : hovered ? STAGE.text3 : STAGE.frame
  return (
    <div ref={ref} data-testid={testId} style={{ ...LAYER, display: hidden ? 'none' : 'flex', gap: 6, transition: 'transform 120ms var(--ease-standard)' }} className="flex-col items-center">
      <div
        className="flex items-center gap-2 rounded-full border px-4 py-2.5 transition-colors"
        style={{ background: 'rgba(11,11,12,0.92)', borderColor: border }}
      >
        <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: inBed ? STAGE.live : STAGE.dotOff }} />
        <span className="text-[13px] font-medium text-[#ececec]">{name}</span>
        <span className="ml-1 font-mono text-[22px] font-light leading-none tabular-nums" style={{ color }} data-testid={`${testId}-temp`}>{temperature}</span>
        {busy && <span aria-hidden className="stage-ring" style={{ borderTopColor: color }} />}
      </div>
      <span className="font-mono text-[10px] uppercase tracking-[0.14em]" style={{ color: status.color }} data-testid={`${testId}-status`}>{status.text}</span>
      <span aria-hidden className="block h-7 w-px" style={{ background: `linear-gradient(${border}, transparent)` }} />
    </div>
  )
})

export interface ZoneLabelProps {
  zone: string
  value: string
  color: string
  testId: string
}

/** OUTER / CENTER / INNER readout beside the bed: a pill with a dot in the reading's colour, the name and the value to a tenth. */
export const ZoneLabel = forwardRef<HTMLDivElement, ZoneLabelProps>(function ZoneLabel({ zone, value, color, testId }, ref) {
  return (
    <div
      ref={ref}
      data-testid={testId}
      data-stage-zone={zone}
      style={{ ...LAYER, opacity: 0, willChange: 'transform, opacity', background: 'rgba(11,11,12,0.78)', borderColor: STAGE.frame }}
      className="flex items-center gap-[7px] whitespace-nowrap rounded-full border px-[9px] py-1 font-mono text-[10px]"
    >
      <span aria-hidden className="size-1.5 rounded-full" style={{ background: color }} />
      <span className="tracking-[0.12em] text-[#8b8b92]">{zone}</span>
      <span className="text-[#ececec] tabular-nums">{value}</span>
    </div>
  )
})
