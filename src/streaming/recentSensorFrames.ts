/** Bounded display cache; ingestion and persistence continue independently. */
export type CachedSensorFrame = Record<string, unknown> & { type: string, ts: number }

// Conservative JSON-size bound without serializing every frame a second time.
// Stop walking oversized/deep firmware records as soon as they exceed the cap.
function frameBytes(value: unknown, depth = 0): number {
  if (depth > 12) return Infinity
  if (value == null) return 4
  if (typeof value === 'number') return String(value).length + 1
  if (typeof value === 'boolean') return 5
  if (typeof value === 'string') return Buffer.byteLength(value) * 6 + 2
  if (typeof value !== 'object') return 4
  let bytes = 2
  for (const [key, item] of Object.entries(value)) {
    bytes += (Array.isArray(value) ? 0 : Buffer.byteLength(key) * 6 + 3) + frameBytes(item, depth + 1) + 1
    if (bytes > 64 * 1024) return bytes
  }
  return bytes
}

export class RecentSensorFrames {
  private latest = new Map<string, { frame: CachedSensorFrame, bytes: number }>()
  private latestBytes = 0
  private piezo: Array<{ frame: CachedSensorFrame, bytes: number }> = []
  private bytes = 0

  add(frame: Record<string, unknown>, now = Date.now() / 1000): void {
    if (typeof frame.type !== 'string' || typeof frame.ts !== 'number' || !Number.isFinite(frame.ts)) return
    // Reject clock-corrupt frames and bound both individual records and the cache.
    if (frame.ts > now + 5) return
    if (frame.type === 'piezo-dual' && frame.ts < now - 40) return
    const bytes = frameBytes(frame)
    if (bytes > 64 * 1024) return
    const value = frame as CachedSensorFrame
    const previous = this.latest.get(value.type)
    if (value.type !== 'piezo-dual' && (!previous || value.ts >= previous.frame.ts)) {
      this.latestBytes -= previous?.bytes ?? 0
      this.latest.delete(value.type)
      this.latest.set(value.type, { frame: value, bytes })
      this.latestBytes += bytes
      while (this.latest.size > 32 || this.latestBytes > 256 * 1024) {
        const oldest = this.latest.entries().next().value
        if (!oldest) break
        this.latestBytes -= oldest[1].bytes
        this.latest.delete(oldest[0])
      }
    }
    this.prune(now)
    if (value.type !== 'piezo-dual' || value.ts < now - 40) return
    this.piezo.push({ frame: value, bytes })
    this.bytes += bytes
    while (this.bytes > 512 * 1024) this.bytes -= this.piezo.shift()?.bytes ?? 0
  }

  private prune(now: number): void {
    this.piezo = this.piezo.filter(({ frame, bytes }) => {
      if (frame.ts >= now - 40) return true
      this.bytes -= bytes
      return false
    })
  }

  snapshot(sensors?: Set<string>, now = Date.now() / 1000) {
    return {
      latest: [...this.latest.values()].map(p => p.frame).filter(f => !sensors || sensors.has(f.type)),
      waveform: !sensors || sensors.has('piezo-dual') ? this.window(now - 10, now) : [],
    }
  }

  window(start: number, now = Date.now() / 1000): CachedSensorFrame[] {
    this.prune(now)
    return this.piezo.map(p => p.frame).filter(f => f.ts >= start && f.ts <= start + 10).sort((a, b) => a.ts - b.ts)
  }

  range(now = Date.now() / 1000) {
    this.prune(now)
    const times = this.piezo.map(p => p.frame.ts)
    return { min: times.length ? Math.min(...times) : 0, max: times.length ? Math.max(...times) : 0 }
  }
}
