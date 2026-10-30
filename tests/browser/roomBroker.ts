import { createRequire } from 'node:module'
import net, { type Socket } from 'node:net'

interface Packet { cmd: string, messageId: number, subscriptions?: { topic: string }[] }
const require = createRequire(import.meta.url)
const packets = createRequire(require.resolve('mqtt'))('mqtt-packet') as {
  parser: () => { parse: (buffer: Buffer) => void, on: (event: string, handler: (packet: Packet) => void) => void }
  generate: (packet: Record<string, unknown>) => Buffer
}

/** Minimal loopback-only MQTT peer for the production web fixture. */
export async function roomBroker() {
  const peers = new Set<Socket>()
  const subscriptions: string[] = []
  const server = net.createServer((socket) => {
    peers.add(socket)
    const parser = packets.parser()
    socket.on('data', buffer => parser.parse(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)))
    socket.on('error', () => {})
    parser.on('packet', (packet) => {
      if (packet.cmd === 'connect') socket.write(packets.generate({ cmd: 'connack', returnCode: 0, sessionPresent: false }))
      if (packet.cmd === 'subscribe') {
        subscriptions.push(...(packet.subscriptions ?? []).map(item => item.topic))
        socket.write(packets.generate({ cmd: 'suback', messageId: packet.messageId, granted: [0] }))
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `mqtt://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    publish(report: object) {
      const topic = subscriptions.find(value => value.endsWith('/room/report'))
      if (!topic) throw new Error('Room subscriber missing')
      peers.forEach(peer => peer.write(packets.generate({ cmd: 'publish', qos: 0, retain: false, dup: false, topic, payload: JSON.stringify(report) })))
    },
    async close() {
      peers.forEach(peer => peer.destroy())
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
