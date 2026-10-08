// Colour and status vocabulary of the temperature stage. One ramp colours every
// temperature on the screen (bed, labels, dial, timeline) so the eye learns it once.

import { TEMP } from '@/src/lib/tempColors'
import { setpointFToDisplay } from '@/src/lib/tempUtils'
import type { TempUnit } from '@/src/lib/tempUtils'
import { formatLevel } from '@/src/components/TempScreen/nightPhases'
import type { TempDisplay } from '@/src/providers/PrefsProvider'

export type StageSide = 'left' | 'right'
export const STAGE_SIDES: StageSide[] = ['left', 'right']

export const STAGE = {
  app: '#0b0b0c',
  floor: '#121215',
  plinth: '#8e8172',
  frame: '#2a2a2f',
  cover: '#8d9199',
  text: '#ececec',
  text2: '#8b8b92',
  text3: '#5d5d63',
  line: '#1f1f22',
  line2: '#26262a',
  live: '#50c878',
  preview: '#e0b45a',
  cooling: '#6fa8dc',
  warming: '#e0945a',
  dotOff: '#3a3a40',
} as const

/** °F stops: cool blue, the cover's own grey at the middle, warm amber. */
export const TEMP_RAMP: ReadonlyArray<{ f: number, rgb: [number, number, number] }> = [
  { f: 64, rgb: [60, 105, 165] },
  { f: 80.5, rgb: [78, 82, 92] },
  { f: 97, rgb: [180, 108, 60] },
]

/** Linear between the stops, clamped at the ends; no reading is the cover grey. */
export function tempRgb(f: number | null | undefined): [number, number, number] {
  if (f == null || !Number.isFinite(f)) return TEMP_RAMP[1].rgb
  if (f <= TEMP_RAMP[0].f) return TEMP_RAMP[0].rgb
  const last = TEMP_RAMP[TEMP_RAMP.length - 1]
  if (f >= last.f) return last.rgb
  for (let i = 0; i < TEMP_RAMP.length - 1; i++) {
    const a = TEMP_RAMP[i]
    const b = TEMP_RAMP[i + 1]
    if (f >= a.f && f <= b.f) {
      const t = (f - a.f) / (b.f - a.f)
      return [0, 1, 2].map(k => Math.round(a.rgb[k] + (b.rgb[k] - a.rgb[k]) * t)) as [number, number, number]
    }
  }
  return TEMP_RAMP[1].rgb
}

export const tempColor = (f: number | null | undefined) => `rgb(${tempRgb(f).join(',')})`

export type StatusWord = 'OFF' | 'HOLDING' | 'COOLING' | 'WARMING' | 'SCHEDULED'
export interface SideStatus {
  word: StatusWord
  /** "SCHEDULED 79°" carries the scheduled temperature; the others stand alone. */
  text: string
  color: string
}

export interface SideReading {
  on: boolean
  targetF: number
  bedF: number | null
}

/**
 * Off → OFF; within half a degree → HOLDING; else COOLING / WARMING. While the
 * timeline is being scrubbed the word is what the schedule will do then.
 */
export function sideStatus(side: SideReading, unit: TempUnit, display: TempDisplay, previewF?: number | null): SideStatus {
  if (previewF !== undefined) {
    if (previewF === null) return { word: 'OFF', text: 'OFF', color: STAGE.text2 }
    return { word: 'SCHEDULED', text: `SCHEDULED ${formatStageTemp(previewF, unit, display)}`, color: tempColor(previewF) }
  }
  if (!side.on) return { word: 'OFF', text: 'OFF', color: STAGE.text2 }
  if (side.bedF == null || Math.abs(side.targetF - side.bedF) < 0.5) return { word: 'HOLDING', text: 'HOLDING', color: STAGE.text2 }
  return side.targetF < side.bedF
    ? { word: 'COOLING', text: 'COOLING', color: STAGE.cooling }
    : { word: 'WARMING', text: 'WARMING', color: STAGE.warming }
}

/** Degrees ("72°"), the ± offset from 80°F ("+3"), or the Eight Sleep level ("−2"). */
export function formatStageTemp(f: number | null | undefined, unit: TempUnit, display: TempDisplay): string {
  if (f == null || !Number.isFinite(f)) return '—'
  if (display === 'level') return formatLevel(f)
  if (display === 'offset') {
    const o = Math.round(f) - TEMP.BASE_F
    return o > 0 ? `+${o}` : o < 0 ? `−${-o}` : '0'
  }
  return `${Math.round(setpointFToDisplay(f, unit) ?? f)}°`
}

export const clampTargetF = (f: number) => Math.round(Math.max(TEMP.MIN_F, Math.min(TEMP.MAX_F, f)))

/** Vertical drag on the bed: one degree per 14 px, up is warmer. */
export const DRAG_PX_PER_DEGREE = 14
export const dragTargetF = (startF: number, dy: number) => clampTargetF(startF - dy / DRAG_PX_PER_DEGREE)
