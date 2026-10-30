import { describe, expect, it } from 'vitest'
import { HomeSensorCache, ENVIRONMENT_LIFETIME_MS, PUMP_LIFETIME_MS } from '../sensorCache'
import { sample } from '../sample'
const now = 1700000000000

describe('live home sensor cache', () => {
  it('normalizes legacy centidegrees and v2 Celsius without sharing mutable firmware objects', () => {
    const cache = new HomeSensorCache()
    const frame = { type: 'bedTemp', ts: now / 1000, amb: 2150, hu: 4500 }
    cache.record(frame, false, now)
    frame.amb = 3000
    expect(cache.ambient(now)).toMatchObject({ available: true, ts: now, temperature: 21.5, humidity: 45 })
    cache.record({ type: 'bedTemp2', ts: now / 1000 + 1, left: { amb: -327.68 }, right: { amb: 23, hu: 55 } }, false, now + 1000)
    expect(cache.ambient(now + 1000)).toMatchObject({ temperature: 23, humidity: 55 })
  })
  it.each([NaN, Infinity, -32768, undefined, null])('does not invent an ambient measurement from %s', (amb) => {
    const cache = new HomeSensorCache()
    cache.record({ type: 'bedTemp', ts: now / 1000, amb }, false, now)
    expect(cache.ambient(now).temperature).toBeNull()
  })
  it('expires source time without extending it on duplicate or out-of-order arrivals', () => {
    const cache = new HomeSensorCache()
    cache.record({ type: 'bedTemp', ts: now / 1000, amb: 2000 }, false, now)
    cache.record({ type: 'bedTemp2', ts: now / 1000, left: { amb: 30 } }, false, now + 10000)
    cache.record({ type: 'bedTemp', ts: now / 1000 - 1, amb: 3000 }, false, now + 10000)
    expect(cache.ambient(now + 10000)).toMatchObject({ ts: now, expiresAt: now + ENVIRONMENT_LIFETIME_MS, temperature: 20 })
    expect(cache.ambient(now + ENVIRONMENT_LIFETIME_MS)).toMatchObject({ available: false, reason: 'stale', temperature: null })
    expect(cache.ambient(now - 1).available).toBe(false)
  })
  it.each([now / 1000 + 1, NaN, Infinity, -1, 0, (now - ENVIRONMENT_LIFETIME_MS) / 1000])('rejects invalid/future/stale event time %s', (ts) => {
    const cache = new HomeSensorCache()
    cache.record({ type: 'bedTemp', ts, amb: 2000 }, false, now)
    expect(cache.ambient(now).available).toBe(false)
  })
  it('never treats backlog or missing hardware branches as live zero measurements', () => {
    const cache = new HomeSensorCache()
    cache.record({ type: 'bedTemp', ts: now / 1000, amb: 2000 }, true, now)
    expect(cache.ambient(now).available).toBe(false)
    cache.record({ type: 'frzHealth', ts: now / 1000, left: { pump: { rpm: 0 }, temps: { flowrate: 25 } } }, false, now)
    expect(cache.pump('left', now)).toMatchObject({ available: true, rpm: 0, temperature: 25 })
    expect(cache.pump('right', now)).toMatchObject({ rpm: null, temperature: null })
    expect(cache.pump('left', now + PUMP_LIFETIME_MS)).toMatchObject({ available: false, rpm: null, temperature: null })
    cache.clear()
    expect(cache.pump('left', now).reason).toBe('missing')
  })
  it('rejects a clock rollback before receipt, even if the event timestamp is old enough', () => {
    const cache = new HomeSensorCache()
    cache.record({ type: 'bedTemp', ts: now / 1000 - 5, amb: 2000 }, false, now)
    expect(cache.ambient(now - 1)).toMatchObject({ available: false, reason: 'unqualified', temperature: null })
  })
  it('invalid timestamp samples have no usable values or expiry', () => {
    expect(sample('test', NaN, 1000, now, { value: 42 })).toMatchObject({ ts: null, expiresAt: null, value: null, available: false })
  })
})
