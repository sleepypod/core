/** Deterministic PRNG (mulberry32) so generated history is stable across reloads. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Stable seed for a string key (e.g. `${side}:${nightIndex}`). */
export function hashSeed(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function randomBetween(rand: () => number, min: number, max: number): number {
  return min + rand() * (max - min)
}

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** Local midnight `daysAgo` days before today. */
export function startOfDay(daysAgo = 0, now = Date.now()): Date {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - daysAgo)
  return d
}

export const toCelsius = (f: number) => Math.round(((f - 32) * 5 / 9) * 10) / 10
