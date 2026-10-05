import { EventEmitter } from 'node:events'
import { Variant } from 'dbus-next'
import type { Message, MessageBus } from 'dbus-next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BluezTransport } from '../bluez'

const device = '/org/bluez/hci1/dev_AA_BB_CC_DD_EE_FF'
const notify = `${device}/service0042/char0043`
const write = `${device}/service0042/char0050`
const config = { Address: 'AA:BB:CC:DD:EE:FF', SplitBase: false }
const objects = () => ({
  [device]: { 'org.bluez.Device1': { Address: new Variant('s', config.Address), Connected: new Variant('b', true), ServicesResolved: new Variant('b', true) } },
  [notify]: { 'org.bluez.GattCharacteristic1': { UUID: new Variant('s', '0000ffe1-0000-1000-8000-00805f9b34fb') } },
  [write]: { 'org.bluez.GattCharacteristic1': { UUID: new Variant('s', '0000ffe3-0000-1000-8000-00805f9b34fb'), Flags: new Variant('as', ['write']) } },
})
class FakeBus extends EventEmitter {
  disconnect = vi.fn()
  call = vi.fn(async (message: Message): Promise<Message> => ({ body:
    message.member === 'GetNameOwner'
      ? [':1.7']
      : message.member === 'GetManagedObjects'
        ? [objects()]
        : message.member === 'Get' ? [new Variant('b', true)] : [],
  } as Message))
}
let bus: FakeBus
let transport: BluezTransport
const data = vi.fn()
const disconnected = vi.fn()
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  bus = new FakeBus()
  transport = new BluezTransport(() => bus as unknown as MessageBus, 1000)
})
afterEach(() => {
  transport.close()
  vi.useRealTimers()
})
function signal(path: string, changed: Record<string, Variant<unknown>>, sender = ':1.7', iface = 'org.bluez.GattCharacteristic1') {
  bus.emit('message', { type: 4, sender, path, interface: 'org.freedesktop.DBus.Properties', member: 'PropertiesChanged', body: [iface, changed, []] })
}

describe('BlueZ D-Bus adapter', () => {
  it('discovers UUIDs on the configured device without fixed adapter or handles', async () => {
    await transport.connect(config, data, disconnected)
    expect(bus.call.mock.calls.find(([m]) => m.member === 'StartNotify')?.[0].path).toBe(notify)
    expect(bus.call.mock.calls.some(([m]) => m.member === 'Connect')).toBe(false)
    await transport.write(Uint8Array.from([1, 2, 3]))
    const call = bus.call.mock.calls.find(([m]) => m.member === 'WriteValue')?.[0]
    expect(call).toMatchObject({ path: write, signature: 'aya{sv}', body: [[1, 2, 3], { type: { value: 'request' } }] })
  })
  it('waits for a real write reply and propagates a rejection', async () => {
    await transport.connect(config, data, disconnected)
    let reject!: (error: Error) => void
    bus.call.mockImplementationOnce(() => new Promise((_resolve, fail) => {
      reject = fail
    }))
    const pending = transport.write(new Uint8Array(20))
    const assertion = expect(pending).rejects.toThrow('NotPermitted')
    reject(new Error('org.bluez.Error.NotPermitted'))
    await assertion
  })
  it('only forwards notifications from the discovered path and current BlueZ owner', async () => {
    await transport.connect(config, data, disconnected)
    const value = { Value: new Variant('ay', [255, 1, 2]) }
    signal(write, value)
    signal(notify, value, ':1.8')
    signal(notify, value)
    expect(data).toHaveBeenCalledExactlyOnceWith(Uint8Array.from([255, 1, 2]))
  })
  it('rejects calls and closes the bus on timeout; late replies cannot revive it', async () => {
    await transport.connect(config, data, disconnected)
    let finish!: (message: Message) => void
    bus.call.mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve
    }))
    const result = expect(transport.write(new Uint8Array(20))).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(1000)
    await result
    finish({ body: [] } as unknown as Message)
    await expect(transport.write(new Uint8Array(20))).rejects.toThrow('not ready')
    expect(bus.disconnect).toHaveBeenCalledOnce()
  })
  it('invalidates on device disconnect, stopped notifications and BlueZ restart', async () => {
    await transport.connect(config, data, disconnected)
    signal(device, { Connected: new Variant('b', false) }, ':1.7', 'org.bluez.Device1')
    expect(disconnected).toHaveBeenCalledOnce()
    await expect(transport.write(new Uint8Array(20))).rejects.toThrow('not ready')
    await transport.connect(config, data, disconnected)
    signal(notify, { Notifying: new Variant('b', false) })
    expect(disconnected).toHaveBeenCalledTimes(2)
    await transport.connect(config, data, disconnected)
    bus.emit('message', { type: 4, sender: 'org.freedesktop.DBus', interface: 'org.freedesktop.DBus', member: 'NameOwnerChanged', body: ['org.bluez', ':1.7', ''] })
    expect(disconnected).toHaveBeenCalledTimes(3)
  })
  it('rejects unknown devices without attempting scanning or pairing', async () => {
    await expect(transport.connect({ ...config, Address: '00:00:00:00:00:00' }, data, disconnected)).rejects.toThrow('unknown to BlueZ')
    expect(bus.call.mock.calls.some(([m]) => ['Pair', 'StartDiscovery', 'Connect'].includes(m.member))).toBe(false)
  })
  it('connects a known disconnected device before subscribing', async () => {
    const normal = bus.call.getMockImplementation()
    if (!normal) throw new Error('Missing mock implementation')
    let reads = 0
    bus.call.mockImplementation(async (message) => {
      if (message.member === 'GetManagedObjects' && reads++ === 0) {
        const snapshot = objects()
        snapshot[device]['org.bluez.Device1'].Connected = new Variant('b', false)
        return { body: [snapshot] } as unknown as Message
      }
      return normal(message)
    })
    await transport.connect(config, data, disconnected)
    expect(bus.call.mock.calls.some(([m]) => m.member === 'Connect')).toBe(true)
  })
  it('handles bus errors and shutdown during discovery without starting notify', async () => {
    bus.call.mockImplementationOnce(() => new Promise(() => {}))
    const connected = transport.connect(config, data, disconnected)
    const result = expect(connected).rejects.toThrow('closed')
    bus.emit('error', new Error('socket failure'))
    await result
    expect(disconnected).toHaveBeenCalledOnce()
    bus.emit('error', new Error('late socket error'))
    expect(disconnected).toHaveBeenCalledOnce()
  })
  it('detects clean bus loss through a bounded heartbeat', async () => {
    await transport.connect(config, data, disconnected)
    bus.call.mockImplementationOnce(() => new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(6000)
    expect(disconnected).toHaveBeenCalledOnce()
    expect(bus.disconnect).toHaveBeenCalledOnce()
  })
})
