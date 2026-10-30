import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeH5106Reply, GoveeReadSession, READ_TIMEOUT_MS, unavailableGoveeReport } from './govee-protocol.mjs'

const issuedAt = 1793000000000
const request = { issuedAt, transaction: `v_${issuedAt}000` }
const packet = { retain: false, dup: false, qos: 0 }
// Synthetic frame values in the qualified H5106 layout; unused bytes are zero-filled.
const payload = { cmd: 'status', sku: 'H5106', device: 'test-monitor', transaction: request.transaction,
  op: { command: ['CGYAAAAAAAAAFdYAAAAAAAAAAAA=', 'AQMAAAAAAAAAAAAAAAAAAAAAAAA=', 'AQAAAAAAAAAAAAAAAAAAAAAAAAA='] } }

test('decodes a correlated synthetic status layout without rounding humidity or dropping zero particles', () => {
  assert.deepEqual(decodeH5106Reply(payload, packet, request, 'test-monitor', issuedAt + 936),
    { temperatureC: 21.5, humidity: 55.9, pm25: 0 })
})

test('rejects wrong devices, requests, cached/duplicate delivery and unsupported message layouts', () => {
  for (const changed of [{ device: 'another-monitor' }, { sku: 'H5101' }, { cmd: 'pt' },
    { transaction: 'an-old-read' }, { op: { command: [] } },
    { op: { command: [...payload.op.command, payload.op.command[0]] } },
    { op: { command: [payload.op.command[0], payload.op.command[2], payload.op.command[1]] } },
    { op: { command: ['not-base64', ...payload.op.command.slice(1)] } }]) {
    assert.equal(decodeH5106Reply({ ...payload, ...changed }, packet, request, 'test-monitor', issuedAt + 100), null)
  }
  for (const metadata of [{ ...packet, retain: true }, { ...packet, dup: true }, { ...packet, qos: 1 }, {}, undefined]) {
    assert.equal(decodeH5106Reply(payload, metadata, request, 'test-monitor', issuedAt + 100), null)
  }
  for (const timestamp of [issuedAt - 1, issuedAt + READ_TIMEOUT_MS + 1, NaN, 1.5]) {
    assert.equal(decodeH5106Reply(payload, packet, request, 'test-monitor', timestamp), null)
  }
})

test('rejects malformed climate values while preserving a real zero-degree status response', () => {
  for (const [offset, value] of [[0, 6001], [9, 10001], [18, 2001]]) {
    const frame = Buffer.from(payload.op.command[0], 'base64')
    frame.writeUInt16BE(value, offset)
    assert.equal(decodeH5106Reply({ ...payload, op: { command: [frame.toString('base64'), ...payload.op.command.slice(1)] } },
      packet, request, 'test-monitor', issuedAt + 100), null)
  }
  const frame = Buffer.from(payload.op.command[0], 'base64')
  frame.writeUInt16BE(0, 0)
  assert.equal(decodeH5106Reply({ ...payload, op: { command: [frame.toString('base64'), ...payload.op.command.slice(1)] } },
    packet, request, 'test-monitor', issuedAt + 100).temperatureC, 0)
})

test('a connection cannot replay, overlap, resurrect or accept an expired read', () => {
  const session = new GoveeReadSession('test-monitor')
  assert.equal(session.begin(issuedAt), null)
  session.connect()
  assert.deepEqual(session.begin(issuedAt), request)
  assert.equal(session.begin(issuedAt + 1), null)
  const report = session.receive(payload, packet, issuedAt + 100)
  assert.equal(report.requestIssuedAt, issuedAt)
  assert.equal(report.observedAt, issuedAt + 100)
  assert.equal(session.receive(payload, packet, issuedAt + 101), null)
  assert.equal(session.begin(issuedAt), null)
  session.begin(issuedAt + 1000)
  session.disconnect()
  session.connect()
  assert.equal(session.receive({ ...payload, transaction: `v_${issuedAt + 1000}000` }, packet, issuedAt + 1100), null)
  session.begin(issuedAt + 2000)
  assert.equal(session.expire(issuedAt + 2000 + READ_TIMEOUT_MS + 1), true)
  assert.equal(session.receive({ ...payload, transaction: `v_${issuedAt + 2000}000` }, packet, issuedAt + 2100), null)
  session.begin(issuedAt + 3000)
  assert.equal(session.expire(issuedAt + 2999), true)
  assert.deepEqual(unavailableGoveeReport(issuedAt + 4000),
    { version: 1, requestIssuedAt: null, observedAt: issuedAt + 4000, reading: null })
})
