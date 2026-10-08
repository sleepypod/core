// The heat painted into the mattress top. A small canvas, repainted only when its
// inputs change, becomes the texture on the slab's caps. Nothing floats above the fabric.

import { STAGE, tempColor, tempRgb } from './stageColors'
import type { StageSide } from './stageColors'

export const HEAT = {
  width: 328,
  height: 280,
  /** Bed top in world units; the canvas maps onto it. */
  bedLength: 4.1,
  bedWidth: 3.5,
  /** Centre of each half along z (+ is the left sleeper's side). */
  sideZ: 0.875,
  /** Zone centres relative to the half's centre: OUTER, CENTER, INNER from the edge in. */
  zoneOffsets: [0.52, 0, -0.52] as const,
  zoneRadius: 0.36,
  zoneSquash: 0.34,
  /** The two washes fade into each other across this much of the half at the seam. */
  seam: 0.06,
  highlightHover: 0.08,
  highlightSelected: 0.14,
} as const

export const ZONE_NAMES = ['OUTER', 'CENTER', 'INNER'] as const
export type ZoneIndex = 0 | 1 | 2

export interface SidePaint {
  /** The colour the half wears: target while on, measured while off, scheduled while previewing. */
  shownF: number | null
  /** Measured zone temperatures in °F, OUTER / CENTER / INNER; null when unknown. */
  zonesF: [number | null, number | null, number | null]
  /** 0..1 eased zone visibility. */
  zoneVisibility: number
  /** 0..1 eased hover / selection highlight. */
  highlight: number
}

export type HeatInput = Record<StageSide, SidePaint>

const round2 = (value: number) => Math.round(value * 100) / 100

/** Cache key: repaint only when something the painter uses has changed. */
export function heatKey(input: HeatInput): string {
  return (['left', 'right'] as StageSide[]).map((side) => {
    const s = input[side]
    const zones = s.zoneVisibility > 0 ? s.zonesF.map(z => z == null ? 'x' : Math.round(z * 2) / 2).join(',') : '-'
    return `${s.shownF == null ? 'x' : Math.round(s.shownF * 2) / 2}|${zones}|${round2(s.zoneVisibility)}|${round2(s.highlight)}`
  }).join('/')
}

/** World z → canvas row. The left sleeper's half (+z) is the top half of the canvas. */
export const zToRow = (z: number) => (0.5 - z / HEAT.bedWidth) * HEAT.height
/** World x → canvas column. */
export const xToColumn = (x: number) => (x / HEAT.bedLength + 0.5) * HEAT.width

const sideSign = (side: StageSide) => side === 'left' ? 1 : -1
/** The rows a half covers, outer edge first. */
export function sideRows(side: StageSide): { edge: number, seam: number } {
  const sign = sideSign(side)
  return { edge: zToRow(sign * HEAT.bedWidth / 2), seam: zToRow(0) }
}

let knit: CanvasPattern | null | undefined

/** 8 × 3 tile: a dark rib row, a pale row, a dark column, as a fine knit over the cover. */
function knitPattern(context: CanvasRenderingContext2D): CanvasPattern | null {
  if (knit !== undefined) return knit
  const tile = document.createElement('canvas')
  tile.width = 8
  tile.height = 3
  const c = tile.getContext('2d')
  if (!c) return knit = null
  c.fillStyle = 'rgba(0,0,0,0.11)'
  c.fillRect(0, 0, 8, 1)
  c.fillStyle = 'rgba(255,255,255,0.05)'
  c.fillRect(0, 1, 8, 1)
  c.fillStyle = 'rgba(0,0,0,0.05)'
  c.fillRect(0, 0, 1, 3)
  return knit = context.createPattern(tile, 'repeat')
}

/** For tests: forget the cached pattern. */
export const resetKnit = () => {
  knit = undefined
}

const rgba = (rgb: [number, number, number], alpha: number) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`

/**
 * Paint the heat field: cover grey, a wash per half in its shown colour that fades at
 * the seam so the sides blend, three soft zone ellipses per half when visible, the
 * hover/selection highlight and the knit on top.
 */
export function paintHeat(context: CanvasRenderingContext2D, input: HeatInput) {
  const { width, height } = HEAT
  context.globalCompositeOperation = 'source-over'
  context.fillStyle = STAGE.cover
  context.fillRect(0, 0, width, height)

  for (const side of ['left', 'right'] as StageSide[]) {
    const paint = input[side]
    const { edge, seam } = sideRows(side)
    const top = Math.min(edge, seam)
    const halfHeight = Math.abs(seam - edge)
    const rgb = tempRgb(paint.shownF)
    const wash = context.createLinearGradient(0, edge, 0, seam)
    wash.addColorStop(0, rgba(rgb, 0.85))
    wash.addColorStop(1 - HEAT.seam, rgba(rgb, 0.9))
    wash.addColorStop(1, rgba(rgb, 0.15))
    context.fillStyle = wash
    context.fillRect(0, top, width, halfHeight)

    if (paint.zoneVisibility > 0.001) {
      const radius = HEAT.zoneRadius * width
      const centreX = xToColumn(0)
      paint.zonesF.forEach((zoneF, index) => {
        const z = sideSign(side) * (HEAT.sideZ + HEAT.zoneOffsets[index])
        const centreY = zToRow(z)
        const zoneRgb = tempRgb(zoneF)
        const alpha = paint.zoneVisibility
        context.save()
        context.translate(centreX, centreY)
        context.scale(1, HEAT.zoneSquash)
        const glow = context.createRadialGradient(0, 0, 0, 0, 0, radius)
        glow.addColorStop(0, rgba(zoneRgb, 0.95 * alpha))
        glow.addColorStop(0.55, rgba(zoneRgb, 0.55 * alpha))
        glow.addColorStop(1, rgba(zoneRgb, 0))
        context.fillStyle = glow
        context.fillRect(-radius, -radius, radius * 2, radius * 2)
        context.restore()
      })
    }

    if (paint.highlight > 0.001) {
      context.fillStyle = `rgba(255,255,255,${round2(paint.highlight)})`
      context.fillRect(0, top, width, halfHeight)
    }
  }

  const pattern = knitPattern(context)
  if (pattern) {
    context.fillStyle = pattern
    context.fillRect(0, 0, width, height)
  }
}

/** Zone label colour for a reading. */
export const zoneColor = (zoneF: number | null) => tempColor(zoneF)
