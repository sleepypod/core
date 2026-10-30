import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeAppliancePowerReply } from './govee-power-protocol.mjs'
import { GoveeReadSession } from './govee-protocol.mjs'

const request = { issuedAt: 1793000000000, transaction: 'v_1793000000000000' }
const packet = { retain: false, dup: false, qos: 0 }

/** Synthetic frames exercise the qualified envelope without storing a user's device reports. */
export function powerReply(model, power = 0, transaction = request.transaction) {
  const frame = Buffer.alloc(20)
  frame[0] = 0xaa
  frame[1] = 0x17
  frame[19] = 0xbd
  return { cmd: 'status', sku: model, device: `test-${model}`, transaction,
    state: { result: 1, onOff: power },
    op: { command: Array.from({ length: model === 'H712C' ? 11 : 17 }, () => frame.toString('base64')) } }
}

function decode(payload, changes = {}) {
  return decodeAppliancePowerReply(payload, changes.packet ?? packet, changes.request ?? request,
    changes.deviceId ?? 'test-H712C', changes.receivedAt ?? request.issuedAt + 400, changes.model ?? 'H712C')
}

test('both qualified models preserve off/on and expose no fan setting as a speed measurement', () => {
  for (const model of ['H712C', 'H7161']) for (const power of [0, 1]) {
    assert.deepEqual(decode(powerReply(model, power), { model, deviceId: `test-${model}` }), { power })
  }
})

test('rejects stale, retained, mismatched, duplicate, unsuccessful and malformed power responses', () => {
  for (const changes of [{ packet: { ...packet, retain: true } }, { packet: { ...packet, dup: true } },
    { packet: { ...packet, qos: 1 } }, { receivedAt: request.issuedAt - 1 },
    { receivedAt: request.issuedAt + 8001 }, { model: 'H7126' }, { deviceId: 'another-device' },
    { request: { ...request, transaction: 'unrelated' } }]) assert.equal(decode(powerReply('H712C'), changes), null)
  for (const state of [{ onOff: false, result: 1 }, { onOff: 2, result: 1 }, { onOff: '1', result: 1 },
    { onOff: 1, result: 0 }, { onOff: 1 }]) assert.equal(decode({ ...powerReply('H712C'), state }), null)
  for (const changes of [{ cmd: 'turn' }, { sku: 'H7161' }, { transaction: 'old' }, { state: null }, { op: {} }]) {
    assert.equal(decode({ ...powerReply('H712C'), ...changes }), null)
  }
  const malformed = powerReply('H712C')
  const badChecksum = Buffer.from(malformed.op.command[0], 'base64')
  badChecksum[2] = 1
  malformed.op.command[0] = badChecksum.toString('base64')
  assert.equal(decode(malformed), null)
  malformed.op.command[0] = Buffer.alloc(20).toString('base64')
  assert.equal(decode(malformed), null)
  malformed.op.command[0] = 'qhcAAAAAAAAAAAAAAAAAAAAAAA=='
  assert.equal(decode(malformed), null)
  malformed.op.command.pop()
  assert.equal(decode(malformed), null)
})

test('an appliance session consumes only its own correlated response and never resurrects after disconnect', () => {
  const session = new GoveeReadSession('test-H7161', (...arguments_) => decodeAppliancePowerReply(...arguments_, 'H7161'))
  session.connect()
  session.begin(request.issuedAt)
  assert.equal(session.receive(powerReply('H712C'), packet, request.issuedAt + 100), null)
  assert.equal(session.receive(powerReply('H7161'), packet, request.issuedAt + 200).reading.power, 0)
  assert.equal(session.receive(powerReply('H7161'), packet, request.issuedAt + 300), null)
  session.begin(request.issuedAt + 30000)
  session.disconnect()
  assert.equal(session.receive(powerReply('H7161', 1, 'v_1793000030000000'), packet, request.issuedAt + 30100), null)
})
