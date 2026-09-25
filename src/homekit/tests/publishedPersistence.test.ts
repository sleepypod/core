// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge, HAPStorage, Service } from 'hap-nodejs'
import { AccessoryInfo } from 'hap-nodejs/dist/lib/model/AccessoryInfo'
import type { DacMonitor } from '@/src/hardware/dacMonitor'
import { getStatus, startBridge, stopBridge, unpairAll } from '../bridge'
import { loadOrCreateIdentity } from '../storage'

// Replace physical sensors only; publish, HAP's TCP server, models, IDs, and
// persistence remain real. No mDNS traffic escapes the test process.
const accessory = (service: Service) => ({ service, stop: () => {} })
vi.mock('../accessories/thermostat', () => ({
  buildThermostatService: (side: string) => accessory(new Service.Thermostat(`Bed ${side}`, side)),
}))
vi.mock('../accessories/occupancySensor', () => ({
  buildOccupancySensor: (side: string) => accessory(new Service.OccupancySensor(`Occupancy ${side}`, side)),
}))
vi.mock('../accessories/snoozeSwitch', () => ({
  buildSnoozeSwitch: (side: string) => accessory(new Service.Switch(`Snooze ${side}`, side)),
}))
vi.mock('../accessories/primeSwitch', () => ({
  buildPrimeSwitch: () => accessory(new Service.Switch('Prime')),
}))
vi.mock('../accessories/ambientSensor', () => ({
  buildAmbientSensor: () => accessory(new Service.TemperatureSensor('Ambient')),
}))
vi.mock('../accessories/pumpHealthSensor', () => ({
  buildPumpHealthSensor: (side: string) => accessory(new Service.LeakSensor(`Pump ${side}`, side)),
}))

const hapRequire = createRequire(createRequire(import.meta.url).resolve('hap-nodejs'))
const ciao = hapRequire('@homebridge/ciao').default as { getResponder: (...args: unknown[]) => unknown }
const g = globalThis as Record<string, unknown>
const dir = mkdtempSync(join(tmpdir(), 'sleepypod-published-hap-'))
const responders: Array<{ shutdown: ReturnType<typeof vi.fn> }> = []
const ports = new WeakMap<Bridge, number>()
const monitor = {} as DacMonitor
const controller = 'synthetic-controller'
const realPublish = Bridge.prototype.publish

function bridge(): Bridge {
  const b = g.__sp_homekit_bridge__
  assert(b instanceof Bridge)
  return b
}

function snapshot(): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).map(name => [name, readFileSync(join(dir, name), 'utf8')]))
}

function ids(b: Bridge) {
  return b.bridgedAccessories.map(a => ({
    uuid: a.UUID,
    aid: a.aid,
    services: a.services.map(s => ({
      uuid: s.UUID,
      iid: s.iid,
      characteristics: s.characteristics.map(c => ({ uuid: c.UUID, iid: c.iid })),
    })),
  }))
}

async function responds(b: Bridge): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${ports.get(b)}/accessories`, {
    headers: { Connection: 'close' },
  })
  await response.arrayBuffer()
  return response.status
}

beforeAll(() => {
  HAPStorage.setCustomStoragePath(dir)
  g.__sp_homekit_cachedDir__ = dir
  g.__sp_homekit_hapInit__ = true
})

beforeEach(() => {
  for (const name of readdirSync(dir)) rmSync(join(dir, name))
  responders.length = 0
  const identity = { ...loadOrCreateIdentity(), wasPaired: true }
  writeFileSync(join(dir, 'identity.json'), JSON.stringify(identity))
  const info = AccessoryInfo.create(identity.username)
  info.addPairedClient(controller, Buffer.alloc(32, 1), 1)
  info.save()

  vi.spyOn(ciao, 'getResponder').mockImplementation(() => {
    const responder = {
      createService: () => Object.assign(new EventEmitter(), {
        updatePort: vi.fn(),
        advertise: vi.fn().mockResolvedValue(undefined),
        updateTxt: vi.fn(),
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    responders.push(responder)
    return responder
  })
  vi.spyOn(Bridge.prototype, 'publish').mockImplementation(async function (this: Bridge, options, insecure) {
    const listening = once(this, 'listening')
    await realPublish.call(this, { ...options, port: 0, bind: '127.0.0.1', advertiser: 'ciao' as never }, insecure)
    const [port] = await listening
    ports.set(this, port as number)
  })
})

afterEach(async () => {
  for (const responder of responders) responder.shutdown.mockResolvedValue(undefined)
  await stopBridge()
  vi.restoreAllMocks()
})

afterAll(() => {
  for (const key of Object.keys(g)) {
    if (key.startsWith('__sp_homekit_')) Reflect.deleteProperty(g, key)
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('published HomeKit bridge persistence', () => {
  it('restores pairing keys and all accessory IDs through stop and fresh publish', async () => {
    await startBridge(monitor)
    const first = bridge()
    const before = snapshot()
    const firstIds = ids(first)
    const key = first._accessoryInfo?.signSk.toString('hex')
    expect(await responds(first)).toBe(470) // Real HAP authentication-required response.

    await stopBridge()
    expect(snapshot()).toEqual(before)
    await startBridge(monitor)
    const fresh = bridge()
    expect(fresh).not.toBe(first)
    expect(fresh._accessoryInfo?.signSk.toString('hex')).toBe(key)
    expect(fresh._accessoryInfo?.isPaired(controller)).toBe(true)
    expect(ids(fresh)).toEqual(firstIds)
    expect(snapshot()).toEqual(before)
    expect(await responds(fresh)).toBe(470)
  })

  it('keeps a server-destruction failure live and retryable without deleting data', async () => {
    await startBridge(monitor)
    const first = bridge()
    const before = snapshot()
    assert(first._server)
    vi.spyOn(first._server, 'destroy').mockImplementationOnce(() => {
      throw new Error('server teardown failed')
    })

    await expect(stopBridge()).rejects.toThrow('server teardown failed')
    expect(getStatus().running).toBe(true)
    expect(await responds(first)).toBe(470)
    expect(snapshot()).toEqual(before)

    await stopBridge()
    expect(getStatus().running).toBe(false)
    expect(snapshot()).toEqual(before)
    await expect(responds(first)).rejects.toThrow()
  })

  it.each([new Error('mDNS unavailable'), 'mDNS unavailable'])(
    'reopens HAP while retired advertiser cleanup rejects with %s', async (failure) => {
      await startBridge(monitor)
      const first = bridge()
      const before = snapshot()
      const firstIds = ids(first)
      const advertiser = first._advertiser
      assert(advertiser instanceof EventEmitter)
      responders[0].shutdown.mockRejectedValue(failure)

      await expect(unpairAll()).rejects.toEqual(failure)
      expect(first._server).toBeUndefined()
      expect(getStatus().running).toBe(false)
      expect(getStatus().setupURI).toBeNull()
      expect(snapshot()).toEqual(before)
      await expect(responds(first)).rejects.toThrow()
      expect(advertiser.listenerCount('updated-name')).toBe(0)

      await startBridge(monitor)
      expect(responders[0].shutdown).toHaveBeenCalledTimes(2)
      expect(getStatus().running).toBe(true)
      expect(getStatus().pairedControllers).toEqual([controller])
      expect(ids(bridge())).toEqual(firstIds)
      expect(snapshot()).toEqual(before)
      expect(await responds(bridge())).toBe(470)
    },
  )
})
