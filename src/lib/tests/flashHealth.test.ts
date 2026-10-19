import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { flashWriteSamples } from '@/src/db/biometrics-schema'
import type { FlashReading } from '../flashHealth'

const files = vi.hoisted(() => new Map<string, string>())
vi.mock('node:fs/promises', () => {
  const readFile = vi.fn(async (p: string) => {
    const v = files.get(p)
    if (v == null) throw new Error('ENOENT')
    return v
  })
  return { readFile, default: { readFile } }
})

const {
  buildFlashReport, parseLifeTime, parsePreEol, parseSectorsWritten, readFlash, recordFlashSample, writeRate,
} = await import('../flashHealth')

const HOUR = 3_600_000
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 9, 17, 0, 0, 0)
/** sectors for n MiB */
const mib = (n: number) => (n * 1024 * 1024) / 512

// Captured from a Pod 5 (FORESEE eMMC) — field 7 is sectors written.
const STAT = '   43154     9400  2711852    39177    21804    18522  3248408  1139238        0    80564  1205189     5197      166  2954288    26227      665      545\n'

function pod(overrides: Record<string, string> = {}) {
  files.clear()
  const base = '/sys/block/mmcblk0'
  const entries: Record<string, string> = {
    [`${base}/stat`]: STAT,
    [`${base}/size`]: '61071360\n',
    [`${base}/device/name`]: 'C9A551\n',
    [`${base}/device/life_time`]: '0x04 0x00\n',
    [`${base}/device/pre_eol_info`]: '0x01\n',
    '/proc/sys/kernel/random/boot_id': 'boot-a\n',
    '/proc/uptime': '2604.89 6984.84\n',
    ...overrides,
  }
  for (const [k, v] of Object.entries(entries)) files.set(k, v)
}

describe('parsers', () => {
  it('maps JEDEC life_time codes to 10% bands, exceeded and undefined', () => {
    expect(parseLifeTime('0x04 0x00\n')).toEqual([{ minPercent: 30, maxPercent: 40 }, null])
    expect(parseLifeTime('0x01 0x0A')).toEqual([{ minPercent: 0, maxPercent: 10 }, { minPercent: 90, maxPercent: 100 }])
    expect(parseLifeTime('0x0B 0x0c')).toEqual([{ minPercent: 100, maxPercent: null }, null])
    expect(parseLifeTime('')).toEqual([null, null])
  })

  it('maps pre_eol_info', () => {
    expect(parsePreEol('0x01\n')).toBe('normal')
    expect(parsePreEol('0x02')).toBe('warning')
    expect(parsePreEol('0x03')).toBe('urgent')
    expect(parsePreEol('0x00')).toBeNull()
  })

  it('reads sectors written from field 7 of the block stat', () => {
    expect(parseSectorsWritten(STAT)).toBe(3248408)
    expect(parseSectorsWritten('1 2 3')).toBeNull()
  })
})

describe('readFlash', () => {
  it('reads the chip and counters', async () => {
    pod()
    expect(await readFlash()).toEqual({
      name: 'C9A551',
      capacityBytes: 61071360 * 512,
      lifeTime: [{ minPercent: 30, maxPercent: 40 }, null],
      preEol: 'normal',
      sectorsWritten: 3248408,
      bootId: 'boot-a',
      uptimeSeconds: 2604.89,
    })
  })

  it('is null without the block device (off-pod)', async () => {
    files.clear()
    expect(await readFlash()).toBeNull()
  })

  it('reports a null boot id when it is unreadable', async () => {
    pod()
    files.delete('/proc/sys/kernel/random/boot_id')
    expect((await readFlash())?.bootId).toBeNull()
  })

  it('still reports writes when the chip hides its health registers', async () => {
    pod()
    files.delete('/sys/block/mmcblk0/device/life_time')
    files.delete('/sys/block/mmcblk0/device/pre_eol_info')
    const r = await readFlash()
    expect(r?.lifeTime).toEqual([null, null])
    expect(r?.preEol).toBeNull()
    expect(r?.sectorsWritten).toBe(3248408)
  })
})

describe('writeRate', () => {
  it('needs an hour of samples', () => {
    expect(writeRate([{ at: T0, bootId: 'a', sectorsWritten: 0 }])).toBeNull()
    expect(writeRate([
      { at: T0, bootId: 'a', sectorsWritten: 0 },
      { at: T0 + HOUR - 1, bootId: 'a', sectorsWritten: mib(100) },
    ])).toBeNull()
  })

  it('scales counter growth within a boot to a day', () => {
    const r = writeRate([
      { at: T0, bootId: 'a', sectorsWritten: mib(1000) },
      { at: T0 + 2 * HOUR, bootId: 'a', sectorsWritten: mib(1100) },
    ])
    expect(r).toEqual({ bytesPerDay: 1200 * 1024 * 1024, coveredMs: 2 * HOUR })
  })

  it('counts a new boot from zero instead of going negative', () => {
    const r = writeRate([
      { at: T0, bootId: 'a', sectorsWritten: mib(5000) },
      { at: T0 + 12 * HOUR, bootId: 'b', sectorsWritten: mib(300) },
      { at: T0 + DAY, bootId: 'b', sectorsWritten: mib(700) },
    ])
    expect(r?.bytesPerDay).toBe(700 * 1024 * 1024)
  })

  it('treats a counter that went backwards as a reboot', () => {
    const r = writeRate([
      { at: T0, bootId: 'a', sectorsWritten: mib(5000) },
      { at: T0 + DAY, bootId: 'a', sectorsWritten: mib(700) },
    ])
    expect(r?.bytesPerDay).toBe(700 * 1024 * 1024)
  })
})

describe('buildFlashReport', () => {
  let raw: Database.Database
  let db: ReturnType<typeof drizzle<typeof schema>>

  beforeEach(() => {
    raw = new Database(':memory:')
    db = drizzle(raw, { schema })
    migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'src/db/biometrics-migrations') })
  })

  afterEach(() => raw.close())

  const reading = (sectorsWritten: number, bootId = 'boot-a'): FlashReading => ({
    name: 'C9A551',
    capacityBytes: 29 * 1024 ** 3,
    lifeTime: [{ minPercent: 30, maxPercent: 40 }, null],
    preEol: 'normal',
    sectorsWritten,
    bootId,
    uptimeSeconds: 7200,
  })

  it('has no per-day rate before samples cover an hour', () => {
    const report = buildFlashReport(db, reading(mib(50)), T0)
    expect(report.perDay).toBeNull()
    expect(report.sinceBoot).toEqual({ bytes: 50 * 1024 * 1024, uptimeSeconds: 7200 })
  })

  it('records nothing and leaves the live reading out of the rate without a boot id', () => {
    recordFlashSample(db, reading(mib(0)), T0)
    recordFlashSample(db, { ...reading(mib(100)), bootId: null }, T0 + HOUR)
    expect(db.select().from(flashWriteSamples).all()).toHaveLength(1)
    const report = buildFlashReport(db, { ...reading(mib(400)), bootId: null }, T0 + 4 * HOUR)
    expect(report.perDay).toBeNull()
    expect(report.sinceBoot.bytes).toBe(400 * 1024 * 1024)
  })

  it('averages stored samples up to the live reading', () => {
    recordFlashSample(db, reading(mib(0)), T0)
    recordFlashSample(db, reading(mib(100)), T0 + HOUR)
    const report = buildFlashReport(db, reading(mib(400)), T0 + 4 * HOUR)
    expect(report.perDay).toEqual({ bytes: 2400 * 1024 * 1024, coveredHours: 4 })
    expect(report.device).toBe('mmcblk0')
  })

  it('builds insights from persisted counters and the live reading without writing rows', () => {
    recordFlashSample(db, reading(mib(0)), T0)
    recordFlashSample(db, reading(mib(100)), T0 + HOUR)
    const report = buildFlashReport(db, reading(mib(200)), T0 + 2 * HOUR)
    expect(report.insights.windows[0]).toEqual({ hours: 1, coveredHours: 1, bytes: 100 * 1024 ** 2, bytesPerDay: 2400 * 1024 ** 2 })
    expect(report.insights.windows[1].coveredHours).toBe(2)
    expect(db.select().from(flashWriteSamples).all()).toHaveLength(2)
  })

  it('ignores samples older than a week', () => {
    recordFlashSample(db, reading(0, 'old'), T0 - 8 * DAY)
    recordFlashSample(db, reading(mib(100)), T0)
    const report = buildFlashReport(db, reading(mib(200)), T0 + 2 * HOUR)
    expect(report.perDay).toEqual({ bytes: 1200 * 1024 * 1024, coveredHours: 2 })
    expect(db.select().from(flashWriteSamples).all()).toHaveLength(2)
  })
})
