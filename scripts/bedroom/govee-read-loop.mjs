import { GoveeReadSession, unavailableGoveeReport } from './govee-protocol.mjs'

export const READ_INTERVAL_MS = 30000

/** The only outbound device command is a status read; source loss withdraws this device's observations. */
export function startGoveeReadLoop({ client, deviceId, deviceTopic, accountTopic, statusVersion, decodeReply }, report,
  { now = Date.now, repeat = setInterval, cancel = clearInterval, closeClientOnStop = true } = {}) {
  const session = new GoveeReadSession(deviceId, decodeReply)
  let generation = 0
  let stopped = false
  let withdrawn = false
  let lastRequestAt = 0
  let lastDelivery = Promise.resolve()

  function deliver(receipt) {
    // The caller serializes transport. Do not make a failed receipt fresh by changing its clock.
    lastDelivery = Promise.resolve(report(receipt)).catch(() => {})
    return lastDelivery
  }

  function withdraw() {
    if (withdrawn) return lastDelivery
    withdrawn = true
    return deliver(unavailableGoveeReport(now()))
  }

  function read() {
    const request = session.begin(now())
    if (!request) return
    lastRequestAt = request.issuedAt
    const requestGeneration = generation
    client.publish(deviceTopic, JSON.stringify({ msg: {
      cmd: 'status', cmdVersion: statusVersion, transaction: request.transaction,
      type: 0, accountTopic,
    } }), { qos: 0, retain: false }, (error) => {
      if (error && generation === requestGeneration && !stopped && session.cancel(request.transaction)) {
        withdraw()
      }
    })
  }

  function disconnected() {
    if (stopped) return
    generation += 1
    session.disconnect()
    withdraw()
  }

  client.on('connect', () => {
    if (stopped) return
    generation += 1
    const connectedGeneration = generation
    session.disconnect()
    client.subscribe(accountTopic, { qos: 0 }, (error) => {
      if (stopped || generation !== connectedGeneration) return
      if (error) return disconnected()
      session.connect()
      read()
    })
  })
  for (const event of ['close', 'offline', 'error']) client.on(event, disconnected)
  client.on('message', (topic, bytes, packet) => {
    if (stopped || topic !== accountTopic || bytes.length > 32768) return
    try {
      let payload = JSON.parse(bytes.toString('utf8'))
      if (payload.msg) payload = typeof payload.msg === 'string' ? JSON.parse(payload.msg) : payload.msg
      const receipt = session.receive(payload, packet, now())
      if (receipt) {
        withdrawn = false
        deliver(receipt)
      }
    }
    catch { /* A malformed or unrecognized reply cannot extend the pending read's deadline. */ }
  })

  const timer = repeat(() => {
    if (stopped) return
    if (session.expire(now())) withdraw()
    if (session.connected && !session.pending && now() - lastRequestAt >= READ_INTERVAL_MS) read()
  }, 500)

  return {
    async stop() {
      if (stopped) return
      stopped = true
      generation += 1
      session.disconnect()
      cancel(timer)
      await withdraw()
      if (closeClientOnStop) client.end(true)
    },
  }
}
