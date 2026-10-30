import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { startGoveeReadLoop } from './govee-read-loop.mjs'
import { decodeAppliancePowerReply } from './govee-power-protocol.mjs'

function fixture() {
  let clock = 1793000000000
  let tick
  const client = new EventEmitter()
  const requests = []
  const reports = []
  client.publish = (topic, contents, options, callback) => {
    requests.push({ topic, contents: JSON.parse(contents), options })
    callback()
  }
  client.subscribe = (_topic, _options, callback) => callback()
  client.end = () => {
    client.ended = true
  }
  const loop = startGoveeReadLoop({ client, deviceId: 'test-monitor', deviceTopic: 'device-topic',
    accountTopic: 'account-topic', statusVersion: 0 }, receipt => reports.push(receipt),
  { now: () => clock, repeat: (callback) => {
    tick = callback
    return 1
  }, cancel: () => {} })
  return { client, requests, reports, loop, advance: (milliseconds) => {
    clock += milliseconds
    tick()
  },
  reply(changes = {}, packet = { retain: false, dup: false, qos: 0 }) {
    const payload = { cmd: 'status', sku: 'H5106', device: 'test-monitor',
      transaction: requests.at(-1).contents.msg.transaction,
      op: { command: ['CGYAAAAAAAAAFdYAAAAAAAAAAAA=', 'AQMAAAAAAAAAAAAAAAAAAAAAAAA=', 'AQAAAAAAAAAAAAAAAAAAAAAAAAA='] }, ...changes }
    client.emit('message', 'account-topic', Buffer.from(JSON.stringify(payload)), packet)
  } }
}

test('issues only status reads and delivers a newly correlated reading once', async () => {
  const state = fixture()
  state.client.emit('connect')
  assert.deepEqual(state.requests[0], { topic: 'device-topic', contents: { msg: {
    cmd: 'status', cmdVersion: 0, transaction: 'v_1793000000000000', type: 0, accountTopic: 'account-topic',
  } }, options: { qos: 0, retain: false } })
  state.advance(900)
  state.reply()
  state.reply()
  assert.equal(state.reports.length, 1)
  assert.equal(state.reports[0].reading.temperatureC, 21.5)
  state.client.emit('offline')
  state.client.emit('close')
  assert.equal(state.reports.length, 2)
  assert.equal(state.reports[1].reading, null)
  await state.loop.stop()
  assert.equal(state.client.ended, true)
})

test('retained/malformed/delayed replies expire and reconnect requires another request', async () => {
  const state = fixture()
  state.client.emit('connect')
  const originalTransaction = state.requests[0].contents.msg.transaction
  state.reply({}, { retain: true, dup: false, qos: 0 })
  state.client.emit('message', 'account-topic', Buffer.from('bad-json'), {})
  state.advance(8001)
  state.reply()
  assert.deepEqual(state.reports.map(receipt => receipt.reading), [null])
  state.client.emit('offline')
  state.client.emit('connect')
  state.reply({ transaction: originalTransaction })
  assert.equal(state.reports.length, 1)
  state.advance(500)
  state.reply()
  assert.equal(state.reports.at(-1).reading.humidity, 55.9)
  state.advance(30000)
  assert.equal(state.requests.length, 3)
  await state.loop.stop()
})

test('a late subscription callback cannot revive a disconnected or stopped session', async () => {
  const state = fixture()
  let subscription
  state.client.subscribe = (_topic, _options, callback) => {
    subscription = callback
  }
  state.client.emit('connect')
  state.client.emit('close')
  subscription()
  assert.equal(state.requests.length, 0)
  state.client.emit('connect')
  await state.loop.stop()
  subscription()
  assert.equal(state.requests.length, 0)
})

test('publish failure withdraws the source without retrying an old request', async () => {
  const state = fixture()
  state.client.publish = (_topic, _contents, _options, callback) => callback(new Error('offline'))
  state.client.emit('connect')
  assert.equal(state.reports.length, 1)
  assert.equal(state.reports[0].reading, null)
  state.advance(1000)
  assert.equal(state.reports.length, 1)
  await state.loop.stop()
})

test('a late failed publish callback cannot cancel a newer pending read', async () => {
  const state = fixture()
  const callbacks = []
  state.client.publish = (topic, contents, options, callback) => {
    state.requests.push({ topic, contents: JSON.parse(contents), options })
    callbacks.push(callback)
  }
  state.client.emit('connect')
  state.advance(900)
  state.reply()
  state.advance(30000)
  callbacks[0](new Error('late error'))
  state.reply()
  assert.equal(state.reports.length, 2)
  assert.ok(state.reports.every(receipt => receipt.reading !== null))
  await state.loop.stop()
})

test('two appliance sessions share a connection without mixing receipts or closing each other', async () => {
  const client = new EventEmitter()
  const requests = []
  const reports = { H712C: [], H7161: [] }
  let ended = 0
  client.subscribe = (_topic, _options, callback) => callback()
  client.publish = (topic, contents, _options, callback) => {
    requests.push({ topic, message: JSON.parse(contents).msg })
    callback()
  }
  client.end = () => {
    ended += 1
  }
  const loops = ['H712C', 'H7161'].map(model => startGoveeReadLoop({ client,
    deviceId: `test-${model}`, deviceTopic: model, accountTopic: 'account-topic', statusVersion: 2,
    decodeReply: (...arguments_) => decodeAppliancePowerReply(...arguments_, model) },
  receipt => reports[model].push(receipt), {
    now: () => 1793000000000, repeat: () => 1, cancel: () => {}, closeClientOnStop: false,
  }))
  client.emit('connect')
  assert.deepEqual(requests.map(request => request.topic), ['H712C', 'H7161'])
  assert.ok(requests.every(request => request.message.cmd === 'status'))
  const frame = Buffer.alloc(20)
  frame[0] = 0xaa
  frame[1] = 0x17
  frame[19] = 0xbd
  const emit = model => client.emit('message', 'account-topic', Buffer.from(JSON.stringify({
    cmd: 'status', sku: model, device: `test-${model}`, transaction: requests[0].message.transaction,
    state: { result: 1, onOff: 0 }, op: { command: Array(model === 'H712C' ? 11 : 17).fill(frame.toString('base64')) },
  })), { retain: false, dup: false, qos: 0 })
  emit('H712C')
  assert.equal(reports.H712C[0].reading.power, 0)
  assert.equal(reports.H7161.length, 0)
  await loops[0].stop()
  assert.equal(ended, 0)
  emit('H7161')
  assert.equal(reports.H7161[0].reading.power, 0)
  await loops[1].stop()
  assert.equal(ended, 0)
  assert.ok(Object.values(reports).every(receipts => receipts.at(-1).reading === null))
})
