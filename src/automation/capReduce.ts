/**
 * Pure reducers over a capacitive presence channel array.
 *
 * capSense2 carries `[A1,A2,B1,B2,C1,C2,ref1,ref2]` per side — body-contact load
 * across head/torso/legs (NOT temperature) plus two reference channels. capSense
 * (Pod 3) carries a single scalar. These helpers collapse either shape to scalar
 * stats (for the automation engine) or a three-zone triple (for the UI/replay).
 *
 * Kept dependency-free so both the engine (`signals.biometrics`) and the
 * streaming persistence writer (`streaming/capFramePersistence`) can import it
 * without pulling in a module cycle.
 */

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/**
 * Reduce a per-side capacitive channel array to scalar matrix signals. Returns
 * null when there are no usable channels. `peakZone` is the index (0–2) of the
 * highest paired zone (A/B/C), available only on the full 6-channel frame.
 */
export function reduceCap(values: number[]): { max: number, mean: number, spread: number, peakZone: number | null } | null {
  // capSense2 carries 6 sensor channels + 2 reference channels; drop the refs.
  const zones = values.length >= 8 ? values.slice(0, 6) : values
  if (zones.length === 0) return null
  const max = Math.max(...zones)
  const min = Math.min(...zones)
  // Three paired zones (A/B/C) only when the full 6-channel frame is present.
  const peakZone = zones.length === 6
    ? [mean([zones[0], zones[1]]), mean([zones[2], zones[3]]), mean([zones[4], zones[5]])]
        .reduce((best, v, i, arr) => (v > arr[best] ? i : best), 0)
    : null
  return { max, mean: mean(zones), spread: max - min, peakZone }
}

/**
 * Collapse a channel array to the three paired-zone (head/torso/legs) means used
 * by the spatial replay. Returns null unless the full 6 sensor channels are
 * present — a Pod 3 scalar frame has no spatial resolution to replay.
 */
export function zoneTriple(values: number[]): [number, number, number] | null {
  const zones = values.length >= 8 ? values.slice(0, 6) : values
  // Exactly 6 sensor channels — matches reduceCap's peakZone gating so a
  // persisted frame never carries zones without a corresponding peak vote.
  if (zones.length !== 6) return null
  return [
    mean([zones[0], zones[1]]),
    mean([zones[2], zones[3]]),
    mean([zones[4], zones[5]]),
  ]
}
