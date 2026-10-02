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
