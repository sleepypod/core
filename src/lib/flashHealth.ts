import { readFile } from 'node:fs/promises'
import { flashInsights } from './flashInsights'
import { asc, gte } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { flashWriteSamples } from '@/src/db/biometrics-schema'
import type * as biometricsSchema from '@/src/db/biometrics-schema'

/**
 * eMMC endurance for System → Storage: the chip's own wear estimates
 * (JEDEC life_time / pre_eol_info) and how much the pod writes per day.
 *
 * The kernel has no per-process I/O accounting on the pods, so writes are
 * the whole device — firmware, sleepypod and the OS together.
 */

type Db = BetterSQLite3Database<typeof biometricsSchema>

export const FLASH_DEVICE = process.env.SP_FLASH_DEVICE || 'mmcblk0'
/** /sys/block/<dev>/stat counts in 512-byte sectors regardless of the device's block size. */
const SECTOR_BYTES = 512
const DAY_MS = 86_400_000
const RATE_WINDOW_MS = 7 * DAY_MS
/** Shortest stretch of samples worth turning into a per-day rate. */
const MIN_COVERAGE_MS = 3_600_000

/** One JEDEC life_time estimate: 0x01 = 0–10% of rated endurance used … 0x0A = 90–100%, 0x0B = exceeded. */
export interface WearRange { minPercent: number, maxPercent: number | null }

export type PreEol = 'normal' | 'warning' | 'urgent'

export interface FlashReading {
  name: string | null
  capacityBytes: number | null
  /** [type A (SLC area), type B (MLC area)]; null where the chip doesn't report one. */
  lifeTime: [WearRange | null, WearRange | null]
  preEol: PreEol | null
  sectorsWritten: number
  /** null when /proc/sys/kernel/random/boot_id is unreadable; such readings never feed the rate. */
  bootId: string | null
  uptimeSeconds: number
}

export interface FlashReport {
  insights: ReturnType<typeof flashInsights>
  device: string
  name: string | null
  capacityBytes: number | null
  lifeTime: [WearRange | null, WearRange | null]
  preEol: PreEol | null
  sinceBoot: { bytes: number, uptimeSeconds: number }
  /** Legacy rate retained for existing clients. The card uses gap-aware insights. */
  perDay: { bytes: number, coveredHours: number } | null
}

export function parseWear(code: string | undefined): WearRange | null {
  const n = Number.parseInt(code ?? '', 16)
  if (!Number.isFinite(n) || n < 1 || n > 11) return null
  if (n === 11) return { minPercent: 100, maxPercent: null }
  return { minPercent: (n - 1) * 10, maxPercent: n * 10 }
}

export function parseLifeTime(text: string): [WearRange | null, WearRange | null] {
  const [a, b] = text.trim().split(/\s+/)
  return [parseWear(a), parseWear(b)]
}

export function parsePreEol(text: string): PreEol | null {
  switch (Number.parseInt(text.trim(), 16)) {
    case 1: return 'normal'
    case 2: return 'warning'
    case 3: return 'urgent'
    default: return null
  }
}

/** Field 7 of /sys/block/<dev>/stat: sectors written since boot. */
export function parseSectorsWritten(stat: string): number | null {
  const n = Number(stat.trim().split(/\s+/)[6])
  return Number.isFinite(n) ? n : null
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  }
  catch {
    return null
  }
}

/** Read the device's sysfs entries, or null when it isn't there (dev machines, non-eMMC storage). */
export async function readFlash(device = FLASH_DEVICE): Promise<FlashReading | null> {
  const base = `/sys/block/${device}`
  const [stat, name, size, lifeTime, preEol, bootId, uptime] = await Promise.all([
    readText(`${base}/stat`),
    readText(`${base}/device/name`),
    readText(`${base}/size`),
    readText(`${base}/device/life_time`),
    readText(`${base}/device/pre_eol_info`),
    readText('/proc/sys/kernel/random/boot_id'),
    readText('/proc/uptime'),
  ])
  const sectorsWritten = stat == null ? null : parseSectorsWritten(stat)
  if (sectorsWritten == null) return null
  const sizeSectors = Number(size?.trim())
  return {
    name: name?.trim() || null,
    capacityBytes: sizeSectors > 0 ? sizeSectors * SECTOR_BYTES : null,
    lifeTime: lifeTime == null ? [null, null] : parseLifeTime(lifeTime),
    preEol: preEol == null ? null : parsePreEol(preEol),
    sectorsWritten,
    bootId: bootId?.trim() || null,
    uptimeSeconds: Number(uptime?.trim().split(/\s+/)[0]) || 0,
  }
}

export interface CounterSample { at: number, bootId: string, sectorsWritten: number }

/**
 * Bytes per day across consecutive samples. Within a boot the delta is the
 * counter's growth; across a reboot the counter restarted from zero, so the
 * new reading is all writes since that boot. Writes between the last sample
 * of a boot and its shutdown are never seen.
 */
export function writeRate(samples: CounterSample[]): { bytesPerDay: number, coveredMs: number } | null {
  if (samples.length < 2) return null
  let sectors = 0
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]
    const cur = samples[i]
    // A counter that went backwards also restarted.
    const sameBoot = cur.bootId === prev.bootId && cur.sectorsWritten >= prev.sectorsWritten
    sectors += sameBoot ? cur.sectorsWritten - prev.sectorsWritten : cur.sectorsWritten
  }
  const coveredMs = samples[samples.length - 1].at - samples[0].at
  if (coveredMs < MIN_COVERAGE_MS) return null
  return { bytesPerDay: (sectors * SECTOR_BYTES * DAY_MS) / coveredMs, coveredMs }
}

export function recordFlashSample(db: Db, reading: FlashReading, now: number): void {
  // Without a boot id a reboot can't be told apart from growth.
  if (reading.bootId == null) return
  db.insert(flashWriteSamples)
    .values({ timestamp: new Date(now), bootId: reading.bootId, sectorsWritten: reading.sectorsWritten })
    .run()
}

/** Average over the last week of samples; the live reading closes the window at now. */
export function buildFlashReport(db: Db, reading: FlashReading, now: number, device = FLASH_DEVICE): FlashReport {
  const rows = db.select().from(flashWriteSamples)
    .where(gte(flashWriteSamples.timestamp, new Date(now - RATE_WINDOW_MS - 2 * MIN_COVERAGE_MS)))
    .orderBy(asc(flashWriteSamples.timestamp))
    .all()
  const samples = [
    ...rows.map(r => ({ at: r.timestamp.getTime(), bootId: r.bootId, sectorsWritten: r.sectorsWritten })),
    ...(reading.bootId == null ? [] : [{ at: now, bootId: reading.bootId, sectorsWritten: reading.sectorsWritten }]),
  ]
  const rate = writeRate(samples.filter(s => s.at >= now - RATE_WINDOW_MS))
  return {
    insights: flashInsights(samples, now),
    device,
    name: reading.name,
    capacityBytes: reading.capacityBytes,
    lifeTime: reading.lifeTime,
    preEol: reading.preEol,
    sinceBoot: { bytes: reading.sectorsWritten * SECTOR_BYTES, uptimeSeconds: Math.round(reading.uptimeSeconds) },
    perDay: rate && { bytes: Math.round(rate.bytesPerDay), coveredHours: Math.round((rate.coveredMs / 3_600_000) * 10) / 10 },
  }
}
