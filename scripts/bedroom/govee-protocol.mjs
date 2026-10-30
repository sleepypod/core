/** Qualified H5106 status reads. Cached characteristics are never passed to this decoder. */
export const READ_TIMEOUT_MS = 8000

function statusFrame(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{27}=$/.test(value)) return null
  const frame = Buffer.from(value, 'base64')
  return frame.length === 20 && frame.toString('base64') === value ? frame : null
}

/** Only the correlated, non-retained three-frame status layout qualified on H5106 is accepted. */
export function decodeH5106Reply(payload, packet, request, deviceId, receivedAt) {
  if (!request || !Number.isSafeInteger(request.issuedAt) || request.issuedAt <= 0
    || request.transaction !== `v_${request.issuedAt}000`
    || !Number.isSafeInteger(receivedAt) || receivedAt < request.issuedAt
    || receivedAt - request.issuedAt > READ_TIMEOUT_MS || packet?.retain !== false
    || packet?.dup !== false || packet?.qos !== 0 || payload?.cmd !== 'status'
    || payload?.sku !== 'H5106' || payload?.device !== deviceId
    || payload?.transaction !== request.transaction || !Array.isArray(payload?.op?.command)
    || payload.op.command.length !== 3) return null
  const frames = payload.op.command.map(statusFrame)
  if (frames.some(frame => frame === null)
    || frames[1].readUInt16BE(0) !== 0x0103 || frames[2].readUInt16BE(0) !== 0x0100) return null
  const climate = frames[0]
  const temperatureC = climate.readUInt16BE(0) / 100
  const humidity = climate.readUInt16BE(9) / 100
  const pm25 = climate.readUInt16BE(18)
  if (temperatureC > 60 || humidity > 100 || pm25 > 2000) return null
  return { temperatureC, humidity, pm25 }
}

/** One pending read per connection; disconnect, timeout and consumption invalidate it. */
export class GoveeReadSession {
  constructor(deviceId, decodeReply = decodeH5106Reply) {
    this.deviceId = deviceId
    this.decodeReply = decodeReply
    this.pending = null
    this.connected = false
    this.lastIssuedAt = 0
  }

  connect() {
    this.pending = null
    this.connected = true
  }

  disconnect() {
    this.pending = null
    this.connected = false
  }

  begin(issuedAt) {
    if (!this.connected || this.pending || !Number.isSafeInteger(issuedAt)
      || issuedAt <= this.lastIssuedAt) return null
    this.lastIssuedAt = issuedAt
    this.pending = { issuedAt, transaction: `v_${issuedAt}000` }
    return { ...this.pending }
  }

  expire(now) {
    if (!this.pending || (now >= this.pending.issuedAt && now - this.pending.issuedAt <= READ_TIMEOUT_MS)) return false
    this.pending = null
    return true
  }

  cancel(transaction) {
    if (this.pending?.transaction !== transaction) return false
    this.pending = null
    return true
  }

  receive(payload, packet, receivedAt) {
    if (!this.connected) return null
    const reading = this.decodeReply(payload, packet, this.pending, this.deviceId, receivedAt)
    if (!reading) return null
    const requestIssuedAt = this.pending.issuedAt
    this.pending = null
    return { version: 1, requestIssuedAt, observedAt: receivedAt, reading }
  }
}

/** A failed request withdraws the complete sensor, without inventing a measurement clock. */
export function unavailableGoveeReport(observedAt) {
  return { version: 1, requestIssuedAt: null, observedAt, reading: null }
}
