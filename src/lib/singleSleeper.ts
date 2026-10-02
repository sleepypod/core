import type { Side } from '@/src/hardware/types'

interface SideAway {
  awayMode?: boolean | null
}

/**
 * The single sleeper's side when exactly one side is in away mode, else null.
 *
 * One side away means one person sleeps in the bed, on the other side. The
 * biometrics modules merge the away side's presence, movement and vitals into
 * that side (modules/common/side_mode.py — keep the rule identical), so the UI
 * shows one sleeper instead of a left/right split. Both sides away, or
 * neither, is ordinary per-side operation.
 */
export function singleSleeperSideFor(
  sides: { left?: SideAway | null, right?: SideAway | null } | null | undefined,
): Side | null {
  const leftAway = Boolean(sides?.left?.awayMode)
  const rightAway = Boolean(sides?.right?.awayMode)
  if (leftAway === rightAway) return null
  return leftAway ? 'right' : 'left'
}

/**
 * Whose schedule drives `side`: its own when it isn't away; the single
 * sleeper's when it's the away side of a single-sleeper bed (the whole bed
 * follows the one sleeper); none when both sides are away.
 */
export function scheduleSourceSide(
  side: Side,
  sides: { left?: SideAway | null, right?: SideAway | null } | null | undefined,
): Side | null {
  if (!sides?.[side]?.awayMode) return side
  const single = singleSleeperSideFor(sides)
  return single && single !== side ? single : null
}

/** The side that mirrors `side`'s schedule and power, when `side` is a single sleeper's. */
export function mirrorSideFor(
  side: Side,
  sides: { left?: SideAway | null, right?: SideAway | null } | null | undefined,
): Side | null {
  return singleSleeperSideFor(sides) === side ? (side === 'left' ? 'right' : 'left') : null
}
