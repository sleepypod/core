import { controlRequestSchema, type ControlReceipt, type ControlRequest } from '@/src/controls/contract'

const ALLOWED_ACTIONS = new Set(['temperature', 'power', 'vibration', 'vibration.clear'])
const MAX_PENDING = 8
const MAX_PAYLOAD_BYTES = 4096

export interface MqttPacketFlags {
  retain: boolean
  dup: boolean
}

/** Broker authorization belongs in topic ACLs. This boundary adds expiry and
 * durable at-most-once dispatch through the same service used by native clients. */
export class MqttCommandGateway {
  private pending = 0

  constructor(private readonly submit: (request: ControlRequest) => Promise<ControlReceipt>) {}

  async receive(payload: Buffer, packet: MqttPacketFlags | undefined): Promise<ControlReceipt> {
    if (!packet || packet.retain !== false || packet.dup !== false) throw new Error('retained_or_redelivered_command')
    if (payload.length === 0 || payload.length > MAX_PAYLOAD_BYTES) throw new Error('invalid_command_size')
    if (this.pending >= MAX_PENDING) throw new Error('command_capacity_reached')
    let request: ControlRequest
    try {
      request = controlRequestSchema.parse(JSON.parse(payload.toString('utf8')))
    }
    catch { throw new Error('invalid_command_envelope') }
    if (!ALLOWED_ACTIONS.has(request.action.kind)) throw new Error('unsupported_mqtt_action')
    this.pending++
    try {
      return await this.submit(request)
    }
    finally { this.pending-- }
  }
}

/** HA renders a new UUID and short deadline at the moment the user acts. The
 * rendered request, not a new ID, must be reused if its outcome is uncertain. */
export function mqttClimateCommandTemplate(side: 'left' | 'right', kind: 'temperature' | 'power'): string {
  const action = kind === 'temperature'
    ? `{"kind":"temperature","side":"${side}","temperature":{{ value | int }}}`
    : `{"kind":"power","side":"${side}","powered":{{ 'true' if value == 'heat' else 'false' }}}`
  return `{% set issued = (now().timestamp() * 1000) | int %}`
    + `{% set request_id = '%04x%04x-%04x-4%03x-8%03x-%04x%04x%04x' | format(range(0,65536)|random,range(0,65536)|random,range(0,65536)|random,range(0,4096)|random,range(0,4096)|random,range(0,65536)|random,range(0,65536)|random,range(0,65536)|random) %}`
    + `{"requestId":"{{ request_id }}","issuedAt":{{ issued }},"expiresAt":{{ issued + 30000 }},"action":${action}}`
}
