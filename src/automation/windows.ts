/**
 * Windowed-aggregate buffers — backs `avg|min|max|sum|count(signal, last N min)`.
 *
 * The engine samples every windowed signal once per tick and records the value
 * here; aggregate queries then read back over a trailing time window. Buffers
 * are pruned to the largest window any rule asks for so memory stays bounded.
 */

import type { WindowFn } from './types'

interface Sample {
  t: number // epoch ms
  v: number
}

export class WindowStore {
  private buffers = new Map<string, Sample[]>()

  /** Record a numeric sample for a signal key at time `atMs`. */
  record(key: string, value: number, atMs: number): void {
    let buf = this.buffers.get(key)
    if (!buf) {
      buf = []
      this.buffers.set(key, buf)
    }
    buf.push({ t: atMs, v: value })
  }

  /**
   * Aggregate samples for `key` over the trailing `lastMin` minutes ending at
   * `nowMs`. Returns `undefined` when no samples fall in the window (so the
   * expression propagates "unavailable" and the rule skips). `count` returns 0
   * only if the buffer exists but is empty in-window — callers treat that as a
   * valid zero.
   */
  aggregate(fn: WindowFn, key: string, lastMin: number, nowMs: number): number | undefined {
    const buf = this.buffers.get(key)
    if (!buf) return undefined
    const cutoff = nowMs - lastMin * 60_000
    const values: number[] = []
    for (const s of buf) {
      if (s.t >= cutoff && s.t <= nowMs) values.push(s.v)
    }
    if (fn === 'count') return values.length
    if (values.length === 0) return undefined
    switch (fn) {
      case 'avg':
        return values.reduce((a, b) => a + b, 0) / values.length
      case 'sum':
        return values.reduce((a, b) => a + b, 0)
      case 'min':
        return Math.min(...values)
      case 'max':
        return Math.max(...values)
    }
  }

  /** Drop samples older than `maxAgeMin` minutes before `nowMs`. */
  prune(nowMs: number, maxAgeMin: number): void {
    const cutoff = nowMs - maxAgeMin * 60_000
    for (const [key, buf] of this.buffers) {
      const kept = buf.filter(s => s.t >= cutoff)
      if (kept.length === 0) this.buffers.delete(key)
      else this.buffers.set(key, kept)
    }
  }
}
