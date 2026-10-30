import { READ_TIMEOUT_MS } from './govee-protocol.mjs'

export const POWER_MODELS = ['H712C', 'H7161']

/** Verify the complete status-frame envelope; fan settings are deliberately not decoded as speed. */
function validStatusFrames(commands, model) {
  if (!Array.isArray(commands) || commands.length !== (model === 'H712C' ? 11 : 17)) return false
  return commands.every((value) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{27}=$/.test(value)) return false
    const frame = Buffer.from(value, 'base64')
    return frame.length === 20 && frame.toString('base64') === value
      && [0xaa, 0xac].includes(frame[0]) && frame.reduce((checksum, byte) => checksum ^ byte, 0) === 0
  })
}

/** Accept only a successful power-state response to this appliance's own pending request. */
export function decodeAppliancePowerReply(payload, packet, request, deviceId, receivedAt, model) {
  if (!POWER_MODELS.includes(model) || !request || !Number.isSafeInteger(request.issuedAt) || request.issuedAt <= 0
    || request.transaction !== `v_${request.issuedAt}000`
    || !Number.isSafeInteger(receivedAt) || receivedAt < request.issuedAt
    || receivedAt - request.issuedAt > READ_TIMEOUT_MS || packet?.retain !== false
    || packet?.dup !== false || packet?.qos !== 0 || payload?.cmd !== 'status'
    || payload?.sku !== model || payload?.device !== deviceId || payload?.transaction !== request.transaction
    || payload?.state?.result !== 1 || ![0, 1].includes(payload?.state?.onOff)
    || !validStatusFrames(payload?.op?.command, model)) return null
  return { power: payload.state.onOff }
}
