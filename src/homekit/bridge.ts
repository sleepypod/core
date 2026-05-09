/**
 * HAP Bridge orchestrator.
 *
 * Builds a single Bridge accessory (one HomeKit device) that owns
 * HeaterCooler x2, OccupancySensor x2, prime Switch, snooze Switch x2.
 *
 * State updates are driven by the existing DacMonitor event bus.
 * Pairing data is persisted under /persistent/sleepypod-data/homekit/.
 *
 * mDNS: prefer Avahi when present (already running on Pod) so we coexist
 * with the existing _sleepypod._tcp announcement instead of binding 5353
 * twice. Falls back to ciao in dev.
 */

import { existsSync } from 'node:fs'
import {
  Accessory,
  Bridge,
  Characteristic,
  Service,
  uuid,
} from 'hap-nodejs'

// hap-nodejs declares Categories and MDNSAdvertiser as `const enum`s, which
// are not consumable under TypeScript isolatedModules. Inline the literals.
const CATEGORY_BRIDGE = 2 as const
const ADVERTISER = {
  CIAO: 'ciao',
  AVAHI: 'avahi',
} as const
type Advertiser = typeof ADVERTISER[keyof typeof ADVERTISER]
import type { DacMonitor } from '@/src/hardware/dacMonitor'
import { buildHeaterCoolerService } from './accessories/heaterCooler'
import { buildOccupancySensor } from './accessories/occupancySensor'
import { buildPrimeSwitch } from './accessories/primeSwitch'
import { buildSnoozeSwitch } from './accessories/snoozeSwitch'
import { clearPairings, initHapStorage, loadOrCreateIdentity, readPairedControllers, regenerateIdentity } from './storage'

const BRIDGE_NAME = 'Sleepypod'
const BRIDGE_PORT = 51827

let bridge: Bridge | null = null
let stoppers: Array<() => void> = []
let identityCache: ReturnType<typeof loadOrCreateIdentity> | null = null
let setupURI: string | null = null

export interface BridgeStatus {
  running: boolean
  pincode: string | null
  setupId: string | null
  setupURI: string | null
  username: string | null
  pairedControllers: string[]
}

export async function startBridge(monitor: DacMonitor): Promise<void> {
  if (bridge) return
  initHapStorage()

  const identity = loadOrCreateIdentity()
  identityCache = identity

  const accessory = new Bridge(BRIDGE_NAME, uuid.generate(`sleepypod:${identity.username}`))
  const info = accessory.getService(Service.AccessoryInformation)
  if (info) {
    info
      .setCharacteristic(Characteristic.Manufacturer, 'Sleepypod')
      .setCharacteristic(Characteristic.Model, 'Pod Bridge')
      .setCharacteristic(Characteristic.SerialNumber, identity.username)
      .setCharacteristic(Characteristic.FirmwareRevision, process.env.GIT_SHA ?? '0.0.0')
  }

  // Hold stoppers locally until publish() succeeds. Each accessory builder
  // starts a setInterval / monitor.on subscription; if publish() throws (port
  // 51827 in use, mDNS error), an `enable()` retry would re-build them and
  // the previous timers/listeners would leak.
  const localStoppers: Array<() => void> = []
  for (const side of ['left', 'right'] as const) {
    const heaterCooler = buildHeaterCoolerService(side, monitor)
    const heaterCoolerAcc = wrapAccessory(`Bed ${side}`, `bed-${side}`, identity.username)
    heaterCoolerAcc.addService(heaterCooler.service)
    accessory.addBridgedAccessory(heaterCoolerAcc)
    localStoppers.push(heaterCooler.stop)

    const occupancy = buildOccupancySensor(side)
    const occupancyAcc = wrapAccessory(`Bed ${side} occupancy`, `occupancy-${side}`, identity.username)
    occupancyAcc.addService(occupancy.service)
    accessory.addBridgedAccessory(occupancyAcc)
    localStoppers.push(occupancy.stop)

    const snooze = buildSnoozeSwitch(side)
    const snoozeAcc = wrapAccessory(`Snooze ${side}`, `snooze-${side}`, identity.username)
    snoozeAcc.addService(snooze.service)
    accessory.addBridgedAccessory(snoozeAcc)
    localStoppers.push(snooze.stop)
  }

  const prime = buildPrimeSwitch()
  const primeAcc = wrapAccessory('Prime pod', 'prime', identity.username)
  primeAcc.addService(prime.service)
  accessory.addBridgedAccessory(primeAcc)
  localStoppers.push(prime.stop)

  try {
    await accessory.publish({
      username: identity.username,
      pincode: identity.pincode,
      port: BRIDGE_PORT,
      category: CATEGORY_BRIDGE,
      setupID: identity.setupId,
      advertiser: pickAdvertiser() as never,
    })
  }
  catch (e) {
    for (const stop of localStoppers) {
      try {
        stop()
      }
      catch {
        // already failing — best-effort teardown only
      }
    }
    throw e
  }

  stoppers = localStoppers
  setupURI = accessory.setupURI()
  bridge = accessory

  // Pincode + setupId are sensitive (HAP pairing secret); ADR 0020 mandates
  // they never appear in logs. UI surfaces them via the QR / setup-code panel.
  const paired = readPairedControllers(identity.username).length
  console.log(
    `[homekit] Bridge published: username=${identity.username}, derivedFrom=${identity.derivedFrom ?? 'legacy'}, paired=${paired}`,
  )
}

export async function stopBridge(): Promise<void> {
  for (const stop of stoppers) {
    try {
      stop()
    }
    catch (e) {
      console.warn('[homekit] stopper failed:', e instanceof Error ? e.message : e)
    }
  }
  stoppers = []

  if (bridge) {
    try {
      await bridge.unpublish()
      await bridge.destroy()
    }
    catch (e) {
      console.warn('[homekit] unpublish/destroy failed:', e instanceof Error ? e.message : e)
    }
    bridge = null
  }
  setupURI = null
}

export function getStatus(): BridgeStatus {
  return {
    running: bridge !== null,
    pincode: identityCache?.pincode ?? null,
    setupId: identityCache?.setupId ?? null,
    setupURI,
    username: identityCache?.username ?? null,
    // Read pairings off disk rather than reaching into hap-nodejs's private
    // `_accessoryInfo` field — survives version bumps and works whether or
    // not the bridge is currently published.
    pairedControllers: identityCache ? readPairedControllers(identityCache.username) : [],
  }
}

export async function unpairAll(): Promise<void> {
  // Stop the bridge, then delete the AccessoryInfo / IdentifierCache files
  // hap-nodejs persists pairings into. Identity (username/pincode/setupId)
  // stays put so the next publish re-uses the same accessory and iOS
  // recognizes it after re-pairing.
  const username = identityCache?.username ?? loadOrCreateIdentity().username
  await stopBridge()
  clearPairings(username)
}

export async function regenerate(): Promise<typeof identityCache> {
  await stopBridge()
  identityCache = regenerateIdentity()
  return identityCache
}

function pickAdvertiser(): Advertiser {
  const env = process.env.HOMEKIT_ADVERTISER
  if (env === 'avahi' || env === 'ciao') return env
  // Avahi running locally → use its D-Bus advertiser so we coexist with
  // the existing _sleepypod._tcp service file rather than binding 5353 twice.
  if (existsSync('/var/run/avahi-daemon/socket') || existsSync('/run/avahi-daemon/socket')) {
    return ADVERTISER.AVAHI
  }
  return ADVERTISER.CIAO
}

function wrapAccessory(name: string, id: string, username: string): Accessory {
  return new Accessory(name, uuid.generate(`sleepypod:${username}:${id}`))
}
