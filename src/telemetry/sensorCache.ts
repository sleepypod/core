import { normalizeFrame } from '@/src/streaming/normalizeFrame'
import { finite, sample } from './sample'
import type { Side } from '@/src/hardware/types'

export const ENVIRONMENT_LIFETIME_MS = 120_000
export const PUMP_LIFETIME_MS = 30_000
interface Reading { ts: number, receivedAt: number, values: Record<string, unknown> }

/** A separate live-only cache: replay and startup backlog never refresh home sensors. */
export class HomeSensorCache {
  private environment: Reading | null = null
  private pumps: Reading | null = null

  record(frame: Record<string, unknown>, backlog: boolean, receivedAt: number): void {
    if (backlog || !Number.isFinite(receivedAt) || typeof frame.ts !== 'number') return
    const ts = frame.ts * 1000
    const environment = frame.type === 'bedTemp' || frame.type === 'bedTemp2'
    if (!environment && frame.type !== 'frzHealth') return
    const lifetime = environment ? ENVIRONMENT_LIFETIME_MS : PUMP_LIFETIME_MS
    if (!Number.isSafeInteger(ts) || ts <= 0 || ts > receivedAt || receivedAt - ts >= lifetime) return
    const previous = environment ? this.environment : this.pumps
    // Duplicate arrivals cannot extend freshness; out-of-order records cannot replace newer data.
    if (previous && ts <= previous.ts && receivedAt >= previous.receivedAt) return
    let values: Record<string, unknown>
    if (environment) {
      const normalized = normalizeFrame(frame)
      values = { temperature: finite(normalized.ambientTemp, -100, 100), humidity: finite(normalized.humidity, 0, 100) }
    }
    else {
      values = {}
      for (const side of ['left', 'right'] as const) {
        const wire = frame[side] as { pump?: { rpm?: unknown }, temps?: { flowrate?: unknown } } | undefined
        values[`${side}Rpm`] = finite(wire?.pump?.rpm, 0)
        // Firmware's misleading `flowrate` field is loop temperature in Celsius.
        values[`${side}Temperature`] = finite(wire?.temps?.flowrate, -100, 100)
      }
    }
    const reading = { ts, receivedAt, values }
    if (environment) this.environment = reading
    else this.pumps = reading
  }

  ambient(now = Date.now()) {
    const reading = this.environment
    return sample('live_bed_temperature', reading?.ts ?? null, ENVIRONMENT_LIFETIME_MS, now,
      reading?.values ?? { temperature: null, humidity: null }, !reading || now >= reading.receivedAt)
  }

  pump(side: Side, now = Date.now()) {
    const reading = this.pumps
    return sample('live_frz_health', reading?.ts ?? null, PUMP_LIFETIME_MS, now,
      { rpm: reading?.values[`${side}Rpm`] ?? null, temperature: reading?.values[`${side}Temperature`] ?? null },
      !reading || now >= reading.receivedAt)
  }

  clear(): void {
    this.environment = null
    this.pumps = null
  }
}

const globals = globalThis as typeof globalThis & { __sp_homeSensors?: HomeSensorCache }
export const homeSensors = globals.__sp_homeSensors ??= new HomeSensorCache()
