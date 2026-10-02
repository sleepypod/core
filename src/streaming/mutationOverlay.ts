/**
 * Recent-mutation overlay for polled deviceStatus frames.
 *
 * A mutation (set temperature, power, …) broadcasts an immediate frame with
 * the new target (broadcastMutationStatus). A DAC status poll that was
 * already in flight — or that runs before the firmware applies the command —
 * can still report the OLD target, and its frame used to go out after the
 * overlay: clients showed new → old → new. Polls just after a command
 * describing the old state is known (deviceStateSync's freshness window);
 * this applies the same idea to the live stream.
 *
 * Each side's last target overlay is re-applied to polled frames until a
 * poll reports those values (the firmware has caught up) or
 * OVERLAY_HOLD_MS passes. Only firmware-reported target fields are held;
 * DB-backed flags (alarm state) always come fresh from their source.
 *
 * State lives on globalThis: writers (routers, scheduler) and the DAC
 * monitor's broadcast can load separate module instances under Turbopack.
 */

import type { Side } from '@/src/hardware/types'

/** Upper bound on holding an overlay the firmware never confirms. */
export const OVERLAY_HOLD_MS = 10_000

/** Side fields both set by mutations and reported by the firmware poll. */
const HELD_FIELDS = ['targetTemperature', 'targetLevel'] as const

interface Held {
  fields: Record<string, unknown>
  at: number
}

const G = globalThis as Record<string, unknown>
const KEY = '__sp_mutation_overlays__'

function store(): Partial<Record<Side, Held>> {
  let s = G[KEY] as Partial<Record<Side, Held>> | undefined
  if (!s) {
    s = {}
    G[KEY] = s
  }
  return s
}

/** Remember a mutation's target fields for `side`. Overlays without target
 * fields (e.g. alarm state) leave any held target overlay in place. */
export function recordMutationOverlay(
  side: Side,
  overlay: Record<string, unknown> | undefined,
  now = Date.now(),
): void {
  if (!overlay) return
  const fields: Record<string, unknown> = {}
  for (const key of HELD_FIELDS) {
    if (key in overlay) fields[key] = overlay[key]
  }
  if (Object.keys(fields).length > 0) store()[side] = { fields, at: now }
}

/**
 * Apply `side`'s held overlay to a polled side status. Drops the overlay
 * once the poll reports every held value, or after OVERLAY_HOLD_MS.
 */
export function applyMutationOverlay<T extends Record<string, unknown>>(
  side: Side,
  polled: T,
  now = Date.now(),
): T {
  const s = store()
  const held = s[side]
  if (!held) return polled
  if (now - held.at >= OVERLAY_HOLD_MS) {
    s[side] = undefined
    return polled
  }
  const confirmed = Object.entries(held.fields).every(([k, v]) => Object.is(polled[k], v))
  if (confirmed) {
    s[side] = undefined
    return polled
  }
  return { ...polled, ...held.fields }
}

/** @internal — for tests only */
export function _resetMutationOverlays(): void {
  G[KEY] = undefined
}
