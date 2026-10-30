import { expect, it } from 'vitest'
import { bedroomObservationSchema } from '../contract'
import { bedroomReadingCurrent, bedroomReportedReading } from '../presentation'

it('uses the server lease duration even if the phone clock differs, and expires disconnected data', () => {
  const generatedAt = 1793067000000
  const receivedAt = generatedAt - 30000
  expect(bedroomReadingCurrent(generatedAt, receivedAt, generatedAt + 5000, receivedAt)).toBe(true)
  expect(bedroomReadingCurrent(generatedAt, receivedAt, generatedAt + 5000, receivedAt + 5000)).toBe(false)
  expect(bedroomReadingCurrent(generatedAt, receivedAt, generatedAt + 120000, receivedAt + 15000)).toBe(false)
  expect(bedroomReadingCurrent(generatedAt, receivedAt, generatedAt + 120000, receivedAt, true)).toBe(false)
  expect(bedroomReadingCurrent(generatedAt, receivedAt, generatedAt + 120000, receivedAt - 1)).toBe(false)
})

it('shows only timestamped past reports as history, retaining zero without promoting freshness', () => {
  const now = 1793067000000
  const observation = bedroomObservationSchema.parse({
    source: { id: 'power', deviceId: 'diffuser', deviceName: 'Diffuser', label: 'Power', provider: 'homebridge',
      externalId: 'synthetic-power', metric: 'power', unit: 'on/off', maxAgeSeconds: 120, enabled: true, useForControl: false },
    status: 'cached', value: null, lastValue: 0, unit: 'on/off', observedAt: now - 60000,
    measuredAt: null, receivedAt: now - 60000, expiresAt: now - 1000, timeBasis: 'cached', controlEligible: false,
  })
  expect(bedroomReportedReading(observation, now)).toEqual({ value: 0, timestamp: now - 60000 })
  expect(bedroomReportedReading({ ...observation, observedAt: now + 1 }, now)).toBeNull()
  expect(bedroomReportedReading({ ...observation, observedAt: null }, now)).toBeNull()
  expect(bedroomReportedReading({ ...observation, lastValue: null }, now)).toBeNull()
  expect(bedroomReportedReading({ ...observation, lastValue: NaN }, now)).toBeNull()
  expect(bedroomReportedReading({ ...observation, status: 'disabled' }, now)).toBeNull()
  expect(bedroomReportedReading({ ...observation, status: 'unavailable' }, now)).toBeNull()
})
