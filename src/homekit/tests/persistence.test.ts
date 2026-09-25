// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge, HAPStorage, uuid } from 'hap-nodejs'
import { AccessoryInfo } from 'hap-nodejs/dist/lib/model/AccessoryInfo'
import { IdentifierCache } from 'hap-nodejs/dist/lib/model/IdentifierCache'

// No hardware, databases, or network listeners are needed to exercise teardown.
// Keep HAP, its filesystem storage, and our bridge lifecycle completely real.
vi.mock('../accessories/thermostat', () => ({}))
vi.mock('../accessories/occupancySensor', () => ({}))
vi.mock('../accessories/snoozeSwitch', () => ({}))
vi.mock('../accessories/primeSwitch', () => ({}))
vi.mock('../accessories/ambientSensor', () => ({}))
vi.mock('../accessories/pumpHealthSensor', () => ({}))

import { getStatus, stopBridge, unpairAll } from '../bridge'
import { loadOrCreateIdentity, readPairedControllers } from '../storage'

const g = globalThis as Record<string, unknown>
const dir = mkdtempSync(join(tmpdir(), 'sleepypod-hap-persistence-'))
const controller = 'synthetic-controller'
let mountedBridge: Bridge

function mountBridge(info: AccessoryInfo, cache: IdentifierCache): void {
  const bridge = new Bridge('Persistence test', uuid.generate(`sleepypod:${info.username}`))
  // Same real HAP models that publish() attaches, without opening LAN ports.
  Object.assign(bridge, { _accessoryInfo: info, _identifierCache: cache })
  mountedBridge = bridge
  g.__sp_homekit_bridge__ = bridge
  g.__sp_homekit_stoppers__ = []
}

function snapshot(): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).map(name => [name, readFileSync(join(dir, name), 'utf8')]))
}

beforeAll(() => {
  HAPStorage.setCustomStoragePath(dir)
  g.__sp_homekit_cachedDir__ = dir
})

beforeEach(() => {
  for (const name of readdirSync(dir)) rmSync(join(dir, name))
  const identity = { ...loadOrCreateIdentity(), wasPaired: true }
  writeFileSync(join(dir, 'identity.json'), JSON.stringify(identity))
  g.__sp_homekit_identity__ = identity
  const info = AccessoryInfo.create(identity.username)
  info.addPairedClient(controller, Buffer.alloc(32, 1), 1)
  info.save()
  const cache = new IdentifierCache(identity.username)
  cache.getAID('bed-left')
  cache.getIID('bed-left', 'thermostat', 'left', 'target-temperature')
  cache.save()
  writeFileSync(join(dir, `ControllerStorage.${identity.username.replace(/:/g, '')}.json`), '{}')
  mountBridge(info, cache)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await stopBridge()
})

afterAll(() => {
  for (const key of Object.keys(g)) {
    if (key.startsWith('__sp_homekit_')) Reflect.deleteProperty(g, key)
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('HomeKit persistence with real hap-nodejs', () => {
  it('preserves pairing keys and accessory IDs across repeated stop/reload cycles', async () => {
    const before = snapshot()
    const username = getStatus().username
    assert(username)
    for (let cycle = 0; cycle < 2; cycle++) {
      await stopBridge()
      expect(getStatus().running).toBe(false)
      // Disk assertions catch destroy() deleting data even if HAP caches it.
      expect(snapshot()).toEqual(before)
      expect(readPairedControllers(username)).toEqual([controller])
      const info = AccessoryInfo.load(username)
      const cache = IdentifierCache.load(username)
      assert(info)
      assert(cache)
      expect(info.isPaired(controller)).toBe(true)
      expect(cache.getAID('bed-left')).toBe(2)
      mountBridge(info, cache)
    }
    await stopBridge()
  })

  it('preserves every file on failed shutdown and permits a non-destructive retry', async () => {
    const before = snapshot()
    vi.spyOn(mountedBridge, 'unpublish').mockRejectedValueOnce(new Error('advertiser unavailable'))

    await expect(stopBridge()).rejects.toThrow('advertiser unavailable')
    expect(getStatus().running).toBe(false)
    expect(snapshot()).toEqual(before)
    expect(getStatus().pairedControllers).toEqual([controller])

    await stopBridge()
    expect(getStatus().running).toBe(false)
    expect(snapshot()).toEqual(before)
  })

  it('does not erase pairings or rotate identity when reset teardown fails', async () => {
    const before = snapshot()
    const username = getStatus().username
    vi.spyOn(mountedBridge, 'unpublish').mockRejectedValueOnce(new Error('advertiser unavailable'))

    await expect(unpairAll()).rejects.toThrow('advertiser unavailable')
    expect(getStatus().running).toBe(false)
    expect(getStatus().username).toBe(username)
    expect(snapshot()).toEqual(before)

    await unpairAll()
    expect(getStatus().running).toBe(false)
    expect(getStatus().username).not.toBe(username)
    expect(readdirSync(dir)).toEqual(['identity.json'])
  })

  it('still clears old HAP state and rotates identity on explicit unpair', async () => {
    const username = getStatus().username
    assert(username)
    await unpairAll()
    expect(getStatus().running).toBe(false)
    expect(getStatus().username).not.toBe(username)
    expect(readPairedControllers(username)).toEqual([])
    expect(readdirSync(dir)).toEqual(['identity.json'])
  })
})
