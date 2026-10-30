import assert from 'node:assert/strict'
import test from 'node:test'
import { receiptQueue, resolveDeviceRoutes } from './govee-reader.mjs'

test('device routing matches exact model/identity pairs and refuses ambiguity or topic wildcards', () => {
  const accessories = ['H5106', 'H712C', 'H7161'].map(model => ({ context: {
    gvModel: model, gvDeviceId: `test-${model}`, awsTopic: `test/${model}`,
  } }))
  const devices = ['H712C', 'H7161'].map(model => ({ model, deviceId: `test-${model}` }))
  const capabilities = () => ({ awsStatusCmdVersion: 2 })
  assert.deepEqual(resolveDeviceRoutes(accessories, devices, capabilities).map(device => device.deviceTopic), ['test/H712C', 'test/H7161'])
  assert.throws(() => resolveDeviceRoutes([...accessories, accessories[1]], devices, capabilities))
  assert.throws(() => resolveDeviceRoutes(accessories, [devices[0], devices[0]], capabilities))
  assert.throws(() => resolveDeviceRoutes(accessories, [{ model: 'H7126', deviceId: 'test-H712C' }], capabilities))
  assert.throws(() => resolveDeviceRoutes(accessories, [{ model: 'H7161', deviceId: 'test-H712C' }], capabilities))
  accessories[1].context.awsTopic = 'test/#'
  assert.throws(() => resolveDeviceRoutes(accessories, devices, capabilities))
})

test('serial publication coalesces pending updates and prioritizes the most recent unavailable receipt', async () => {
  const sent = []
  const states = []
  let finish
  const queue = receiptQueue(async (receipt) => {
    sent.push(receipt)
    if (sent.length === 1) await new Promise((resolve) => {
      finish = resolve
    })
    return { accepted: 4 }
  }, state => states.push(state), () => 100000)
  const first = queue({ observedAt: 99900, reading: { temperatureC: 21 } })
  queue({ observedAt: 99950, reading: { temperatureC: 22 } })
  queue({ observedAt: 100000, reading: null })
  finish()
  await first
  assert.equal(sent.length, 2)
  assert.equal(sent[1].reading, null)
  assert.equal(sent[0].observedAt, 99900)
  assert.equal(states.length, 2)
})

test('a failed or expired receipt is never silently re-timestamped or retried', async () => {
  const sent = []
  const states = []
  const queue = receiptQueue(async (receipt) => {
    sent.push(receipt)
    throw new Error('unreachable')
  },
  state => states.push(state), () => 100000)
  await queue({ observedAt: 100000, reading: {} })
  await queue({ observedAt: 1, reading: {} })
  await queue({ observedAt: 101001, reading: {} })
  assert.equal(sent.length, 1)
  assert.deepEqual(states.map(state => state.error), ['publication_unavailable', 'receipt_expired', 'receipt_expired'])
})
