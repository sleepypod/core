import { Message, Variant, systemBus } from 'dbus-next'
import type { MessageBus } from 'dbus-next'
import type { BaseConfiguration, BaseTransport } from './types'

const DEVICE = 'org.bluez.Device1'
const CHARACTERISTIC = 'org.bluez.GattCharacteristic1'
const PROPERTIES = 'org.freedesktop.DBus.Properties'
const NOTIFY_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb'
const WRITE_UUID = '0000ffe3-0000-1000-8000-00805f9b34fb'
type Properties = Record<string, Variant<unknown>>
type Objects = Record<string, Record<string, Properties>>

/** D-Bus replies are correlated; CLI prompts cannot acknowledge a GATT write. */
export class BluezTransport implements BaseTransport {
  private bus: MessageBus | null = null
  private writePath: string | null = null
  private connectionError: ((error: Error) => void) | null = null
  private heartbeat: ReturnType<typeof setTimeout> | null = null
  private pending = new Set<(error: Error) => void>()

  constructor(private readonly createBus = () => systemBus({ negotiateUnixFd: false }), private readonly timeoutMs = 8000) {}

  private async call(bus: MessageBus, path: string, iface: string, member: string, signature = '', body: unknown[] = [], destination = 'org.bluez'): Promise<unknown[]> {
    if (this.bus !== bus) throw new Error('Base connection closed')
    return new Promise((resolve, reject) => {
      const fail = (error: Error) => {
        clearTimeout(timer)
        this.pending.delete(fail)
        reject(error)
      }
      const timer = setTimeout(() => {
        const error = new Error(`Bluetooth ${member} timed out`)
        fail(error)
        this.connectionError?.(error)
      }, this.timeoutMs)
      this.pending.add(fail)
      bus.call(new Message({ destination, path, interface: iface, member, signature, body }))
        .then((reply) => {
          clearTimeout(timer)
          this.pending.delete(fail)
          if (this.bus !== bus) return reject(new Error('Base connection closed'))
          if (!reply) return reject(new Error('Bluetooth returned no reply'))
          resolve(reply.body as unknown[])
        }, fail)
    })
  }

  async connect(config: BaseConfiguration, onData: (data: Uint8Array) => void, onDisconnect: (error: Error) => void): Promise<void> {
    this.close()
    const bus = this.createBus()
    this.bus = bus
    const fail = (error: unknown) => {
      if (this.bus !== bus) return
      this.close()
      onDisconnect(error instanceof Error ? error : new Error('Bluetooth disconnected'))
    }
    this.connectionError = fail
    // Keep an error listener even after disconnect: a late socket error must not
    // become an unhandled EventEmitter error during shutdown/reconnect.
    bus.on('error', fail)
    try {
      const [owner] = await this.call(bus, '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetNameOwner', 's', ['org.bluez'], 'org.freedesktop.DBus')
      const getObjects = async () => (await this.call(bus, '/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects'))[0] as Objects
      let objects = await getObjects()
      const devicePath = Object.keys(objects).find(path => objects[path][DEVICE]?.Address?.value === config.Address)
      if (!devicePath) throw new Error('Configured base is unknown to BlueZ; pair it with the stock setup first')
      const selected = { notifyPath: '' }
      bus.on('message', (message) => {
        if (this.bus !== bus || message.type !== 4) return
        if (message.sender === 'org.freedesktop.DBus' && message.interface === 'org.freedesktop.DBus' && message.member === 'NameOwnerChanged') {
          const [name, , nextOwner] = message.body as unknown[]
          if (name === 'org.bluez' && nextOwner !== owner) fail(new Error('Bluetooth service restarted'))
        }
        if (message.sender !== owner || message.interface !== PROPERTIES || message.member !== 'PropertiesChanged') return
        const [iface, changed, invalidated] = message.body as [string, Properties, string[]]
        if (message.path === devicePath && iface === DEVICE
          && (changed.Connected?.value === false || invalidated.includes('Connected'))) {
          fail(new Error('Base disconnected'))
        }
        if (message.path === selected.notifyPath && iface === CHARACTERISTIC) {
          if (changed.Notifying?.value === false) return fail(new Error('Base notifications stopped'))
          const value = changed.Value?.value
          if (Buffer.isBuffer(value) || (Array.isArray(value) && value.every(b => Number.isInteger(b) && b >= 0 && b <= 255))) {
            onData(Uint8Array.from(value as number[]))
          }
        }
      })
      for (const match of [
        `type='signal',sender='org.bluez',interface='${PROPERTIES}',path_namespace='${devicePath}'`,
        'type=\'signal\',sender=\'org.freedesktop.DBus\',interface=\'org.freedesktop.DBus\',member=\'NameOwnerChanged\',arg0=\'org.bluez\'',
      ]) {
        await this.call(bus, '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'AddMatch', 's', [match], 'org.freedesktop.DBus')
      }
      if (objects[devicePath][DEVICE].Connected?.value !== true) await this.call(bus, devicePath, DEVICE, 'Connect')
      const deadline = Date.now() + this.timeoutMs
      while (true) {
        objects = await getObjects()
        if (objects[devicePath]?.[DEVICE]?.ServicesResolved?.value === true) break
        if (Date.now() >= deadline) throw new Error('Base GATT discovery timed out')
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const characteristic = (uuid: string) => {
        const paths = Object.keys(objects).filter(path => path.startsWith(`${devicePath}/`)
          && objects[path][CHARACTERISTIC]?.UUID?.value === uuid)
        if (paths.length !== 1) throw new Error(`Base characteristic ${uuid} is missing or ambiguous`)
        return paths[0]
      }
      selected.notifyPath = characteristic(NOTIFY_UUID)
      const writePath = characteristic(WRITE_UUID)
      const flags = objects[writePath][CHARACTERISTIC].Flags?.value
      if (!Array.isArray(flags) || !flags.includes('write')) throw new Error('Base does not support acknowledged GATT writes')
      await this.call(bus, selected.notifyPath, CHARACTERISTIC, 'StartNotify')
      this.writePath = writePath
      // dbus-next does not forward a clean socket EOF. A bounded read detects
      // that case and a lost Connected signal without relying on movement.
      const heartbeat = async () => {
        try {
          const [connected] = await this.call(bus, devicePath, PROPERTIES, 'Get', 'ss', [DEVICE, 'Connected'])
          if ((connected as Variant<unknown>).value !== true) throw new Error('Base disconnected')
          if (this.bus === bus) this.heartbeat = setTimeout(() => {
            void heartbeat()
          }, 5000)
        }
        catch (error) { fail(error) }
      }
      this.heartbeat = setTimeout(() => {
        void heartbeat()
      }, 5000)
    }
    catch (error) {
      this.close()
      throw error
    }
  }

  async write(packet: Uint8Array): Promise<void> {
    const bus = this.bus
    const path = this.writePath
    if (!bus || !path) throw new Error('Base Bluetooth connection is not ready')
    await this.call(bus, path, CHARACTERISTIC, 'WriteValue', 'aya{sv}', [Array.from(packet), { type: new Variant('s', 'request') }])
  }

  close(): void {
    if (this.heartbeat) clearTimeout(this.heartbeat)
    this.heartbeat = null
    const bus = this.bus
    this.bus = null
    this.connectionError = null
    this.writePath = null
    for (const reject of this.pending) reject(new Error('Base connection closed'))
    this.pending.clear()
    bus?.disconnect()
  }
}
