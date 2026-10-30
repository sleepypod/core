import assert from 'node:assert/strict'
import test from 'node:test'
import { cacheReadings } from './homebridge-cache.mjs'

const sources = [{ sourceId: 'temperature', aid: 1, iid: 10, metric: 'temperature' },
  { sourceId: 'quality', aid: 1, iid: 11, metric: 'airQuality' },
  { sourceId: 'power', aid: 2, iid: 12, metric: 'power' }]
test('preserves zero temperature, treats unknown air quality as unavailable, routes power', () => {
  assert.deepEqual(cacheReadings([{ aid: 1, services: [{ characteristics: [
    { iid: 10, value: 0 }, { iid: 11, value: 0 }] }] },
  { aid: 2, services: [{ characteristics: [{ iid: 12, value: true }] }] }], sources),
  [{ sourceId: 'temperature', value: 0 }, { sourceId: 'quality', value: null }, { sourceId: 'power', value: 1 }])
})
test('missing, invalid and failed characteristics withdraw their readings', () => {
  for (const characteristic of [{ iid: 10, value: 21, status: -70402 },
    { iid: 10, value: '21' }, { iid: 10, value: NaN }, { iid: 10, value: 150 }, {}]) {
    assert.equal(cacheReadings([{ aid: 1, services: [{ characteristics: [characteristic] }] }], sources)[0].value, null)
  }
  assert.deepEqual(cacheReadings([], sources).map(item => item.value), [null, null, null])
})
