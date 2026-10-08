import type { Side } from '@/src/hardware/types'

export interface BedConfiguration {
  bedMode?: 'two' | 'solo-left' | 'solo-right'
  unusedZoneMode?: 'follow' | 'off' | 'independent'
}

export interface BedState extends BedConfiguration {
  left?: { awayMode?: boolean | number | null } | null
  right?: { awayMode?: boolean | number | null } | null
}

/** Occupancy and thermal zones are independent. Keep Python side_mode.py in sync. */
export function activeSleeperSides(sides: BedState | null | undefined): Side[] {
  const configured: Side[] = sides?.bedMode === 'solo-left'
    ? ['left']
    : sides?.bedMode === 'solo-right' ? ['right'] : ['left', 'right']
  return configured.filter(side => !sides?.[side]?.awayMode)
}

export function singleSleeperSideFor(sides: BedState | null | undefined): Side | null {
  const active = activeSleeperSides(sides)
  return active.length === 1 ? active[0] : null
}

/** No sleeper means no recurring heat. An unused zone has an explicit policy. */
export function scheduleSourceSide(side: Side, sides: BedState | null | undefined): Side | null {
  const active = activeSleeperSides(sides)
  if (active.includes(side)) return side
  if (active.length === 0) return null
  if (sides?.unusedZoneMode === 'independent') return side
  if (sides?.unusedZoneMode === 'follow') return active[0]
  return null
}

export function mirrorSideFor(side: Side, sides: BedState | null | undefined): Side | null {
  const other = side === 'left' ? 'right' : 'left'
  return scheduleSourceSide(other, sides) === side ? other : null
}

/** The schedule editor focuses one source only when the unused zone has no own schedule. */
export function singleScheduleSideFor(sides: BedState | null | undefined): Side | null {
  return sides?.unusedZoneMode === 'independent' ? null : singleSleeperSideFor(sides)
}
