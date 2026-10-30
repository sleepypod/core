import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '@/src/auth/tests/support'
import Database from 'better-sqlite3'
const sources = vi.hoisted(() => ({ fresh: vi.fn(), poll: vi.fn(), occupancy: vi.fn(), cap: vi.fn() }))
vi.mock('@/src/db', () => ({ biometricsDb: { $client: {} } }))
vi.mock('../vitals', () => ({ readHomeVitals: () => ({ available: true, ts: 1700000000000, expiresAt: 1700000300000, heartRate: 60, breathingRate: 15, hrv: 40 }) }))
vi.mock('@/src/hardware/dacMonitor.instance', () => ({ getDacMonitorIfRunning: () => ({ getFreshStatus: sources.fresh, getLastPollAt: sources.poll }) }))
vi.mock('@/src/hardware/pumpStallNotification', () => ({ getPumpStallNotice: () => null }))
vi.mock('@/src/lib/occupancy', () => ({ getOccupancy: sources.occupancy }))
vi.mock('@/src/streaming/piezoStream', () => ({ getLatestCapSenseSnapshot: sources.cap }))
import { readHomeTelemetry, readHomeOccupancy } from '../home'
const now = 1700000000000
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  sources.fresh.mockReset().mockReturnValue(null)
  sources.poll.mockReset().mockReturnValue(now - 1000)
  sources.occupancy.mockReset().mockReturnValue({ available: false, occupied: false, classification: 'none' })
  sources.cap.mockReset().mockReturnValue(null)
})
afterEach(() => vi.useRealTimers())
it('uses reported DAC fields and original poll time, never optimistic persisted device state', () => {
  const side = { targetLevel: -20, currentTemperature: 75, targetTemperature: 70 }
  sources.fresh.mockReturnValue({ leftSide: side, rightSide: { ...side, targetLevel: 0, currentTemperature: null, targetTemperature: null }, waterLevel: 'ok' })
  const readings = readHomeTelemetry(now)
  expect(readings['state/left/climate']).toMatchObject({ ts: now - 1000, available: true, currentTemperature: 75, targetTemperature: 70, mode: 'heat', stateKind: 'reported' })
  expect(readings['state/right/climate']).toMatchObject({ currentTemperature: null, targetTemperature: null, mode: 'off' })
  sources.fresh.mockReturnValue(null)
  expect(readHomeTelemetry(now)['state/left/climate']).toMatchObject({ available: false, currentTemperature: null, mode: null })
  expect(readings['pump/left/stall']).toMatchObject({ source: 'software_stall_notice', active: false })
  expect(readings).not.toHaveProperty('pump/left/clog_detected')
})
it('requires both calibrated occupancy and fresh source/receipt clocks before exporting presence or absence', () => {
  sources.cap.mockReturnValue({ ts: now / 1000, receivedAtMs: now })
  expect(readHomeOccupancy('left', now)).toMatchObject({ available: false, occupied: null })
  sources.occupancy.mockReturnValue({ available: true, occupied: false, classification: 'none' })
  expect(readHomeOccupancy('left', now)).toMatchObject({ available: true, occupied: false })
  expect(readHomeOccupancy('left', now + 30000)).toMatchObject({ available: false, occupied: null })
  sources.cap.mockReturnValue({ ts: now / 1000, receivedAtMs: now + 1 })
  expect(readHomeOccupancy('left', now).available).toBe(false)
  sources.occupancy.mockImplementation(() => {
    throw new Error('missing calibration')
  })
  expect(readHomeOccupancy('left', now).available).toBe(false)
})
it('withholds apparent vitals from an empty or unqualified bed and expires them with occupancy', () => {
  sources.cap.mockReturnValue({ ts: now / 1000, receivedAtMs: now })
  for (const occupancy of [
    { available: false, occupied: true, classification: 'person' },
    { available: true, occupied: false, classification: 'none' },
    { available: true, occupied: true, classification: 'object' },
  ]) {
    sources.occupancy.mockReturnValue(occupancy)
    expect(readHomeTelemetry(now)['state/biometrics/right']).toMatchObject({ available: false, heartRate: null, breathingRate: null, hrv: null })
  }
  sources.occupancy.mockReturnValue({ available: true, occupied: true, classification: 'person' })
  expect(readHomeTelemetry(now)['state/biometrics/right']).toMatchObject({ available: true, heartRate: 60, expiresAt: now + 30000 })
  expect(readHomeTelemetry(now + 30000)['state/biometrics/right'].available).toBe(false)
})

it('withdraws shared vitals and occupancy after personal activation while preserving climate telemetry', () => {
  const database = new Database(process.env.DATABASE_URL)
  try {
    sources.cap.mockReturnValue({ ts: now / 1000, receivedAtMs: now })
    sources.occupancy.mockReturnValue({ available: true, occupied: true, classification: 'person' })
    sources.fresh.mockReturnValue({ leftSide: { targetLevel: -20, currentTemperature: 75, targetTemperature: 70 } })
    expect(readHomeTelemetry(now)['state/biometrics/left'].heartRate).toBe(60)
    database.prepare('INSERT INTO household_privacy_boundary VALUES (1, ?, \'test-arrangement\')').run(now)
    const readings = readHomeTelemetry(now)
    for (const side of ['left', 'right'] as const) {
      expect(readings[`state/biometrics/${side}`]).toMatchObject({ available: false, ts: null, heartRate: null, breathingRate: null, hrv: null, reason: 'privacy_required' })
      expect(readings[`state/occupancy/${side}`]).toMatchObject({ available: false, ts: null, occupied: null, classification: null, reason: 'privacy_required' })
      expect(readHomeOccupancy(side, now).occupied).toBeNull()
    }
    expect(readings['state/left/climate']).toMatchObject({ available: true, currentTemperature: 75, targetTemperature: 70 })
  }
  finally { database.close() }
})
