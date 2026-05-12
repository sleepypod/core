/**
 * HAP Bridge orchestrator.
 *
 * Builds a single Bridge accessory (one HomeKit device) that owns
 * Thermostat x2, PowerSwitch x2, OccupancySensor x2, prime Switch, snooze Switch x2.
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
import { buildOccupancySensor } from './accessories/occupancySensor'
import { buildPowerSwitch } from './accessories/powerSwitch'
import { buildPrimeSwitch } from './accessories/primeSwitch'
import { buildSnoozeSwitch } from './accessories/snoozeSwitch'
import { buildThermostatService } from './accessories/thermostat'
import { clearPairings, initHapStorage, loadOrCreateIdentity, readPairedControllers, regenerateIdentity } from './storage'

const BRIDGE_NAME = 'sleepypod'
const BRIDGE_PORT = 51827

// Turbopack splits this module across the instrumentation chunk and the API
// route chunks, so plain `let` locals would be per-chunk. Back the singleton
// state with globalThis so instrumentation's `startBridge` and the API's
// `getStatus` see the same bridge regardless of which copy ran the import.
const G = globalThis as Record<string, unknown>
const KEYS = {
  bridge: '__sp_homekit_bridge__',
  stoppers: '__sp_homekit_stoppers__',
  identity: '__sp_homekit_identity__',
  setupURI: '__sp_homekit_setupURI__',
  transitioning: '__sp_homekit_transitioning__',
} as const

const getBridge = (): Bridge | null => (G[KEYS.bridge] as Bridge | null) ?? null
const setBridge = (b: Bridge | null): void => {
  G[KEYS.bridge] = b
}

const getStoppers = (): Array<() => void> => (G[KEYS.stoppers] as Array<() => void> | undefined) ?? []
const setStoppers = (s: Array<() => void>): void => {
  G[KEYS.stoppers] = s
}

const getIdentity = (): ReturnType<typeof loadOrCreateIdentity> | null =>
  (G[KEYS.identity] as ReturnType<typeof loadOrCreateIdentity> | null) ?? null
const setIdentity = (i: ReturnType<typeof loadOrCreateIdentity> | null): void => {
  G[KEYS.identity] = i
}

const getSetupURI = (): string | null => (G[KEYS.setupURI] as string | null) ?? null
const setSetupURI = (u: string | null): void => {
  G[KEYS.setupURI] = u
}

// Lifecycle ops (enable/disable/unpair/regenerate) flip this while in flight.
// getStatus surfaces it so a 5s poll racing a sub-second teardown can render
// "rotating…" instead of treating the transient running=false as a final
// state. Lives here (not in index.ts) so bridge.getStatus stays a single
// globalThis read; index.ts owns the flip via setTransitioning.
const isTransitioning = (): boolean => Boolean(G[KEYS.transitioning])
export const setTransitioning = (v: boolean): void => {
  G[KEYS.transitioning] = v
}

export interface BridgeStatus {
  running: boolean
  transitioning: boolean
  pincode: string | null
  setupId: string | null
  setupURI: string | null
  username: string | null
  pairedControllers: string[]
}

export async function startBridge(monitor: DacMonitor): Promise<void> {
  if (getBridge()) return
  initHapStorage()

  const identity = loadOrCreateIdentity()
  setIdentity(identity)

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
    const thermostat = buildThermostatService(side, monitor)
    const thermostatAcc = wrapAccessory(`Bed ${side}`, `bed-${side}`, identity.username)
    thermostatAcc.addService(thermostat.service)
    accessory.addBridgedAccessory(thermostatAcc)
    localStoppers.push(thermostat.stop)

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

    const power = buildPowerSwitch(side, monitor)
    const powerAcc = wrapAccessory(`Bed ${side} power`, `power-${side}`, identity.username)
    powerAcc.addService(power.service)
    accessory.addBridgedAccessory(powerAcc)
    localStoppers.push(power.stop)
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

  setStoppers(localStoppers)
  setSetupURI(accessory.setupURI())
  setBridge(accessory)

  // Pincode + setupId are sensitive (HAP pairing secret); ADR 0020 mandates
  // they never appear in logs. UI surfaces them via the QR / setup-code panel.
  const paired = readPairedControllers(identity.username).length
  console.log(
    `[homekit] Bridge published: username=${identity.username}, derivedFrom=${identity.derivedFrom ?? 'legacy'}, paired=${paired}`,
  )

  // Catch (proven) regression where Turbopack splits this module across
  // entry chunks and per-chunk `let` state diverges. If the bridge we just
  // published isn't readable through globalThis, every API caller will see
  // running=false. Loud assertion is preferable to silent UI desync.
  if (getBridge() !== accessory) {
    console.error('[homekit] singleton invariant violated: globalThis bridge !== freshly published accessory')
  }
}

export async function stopBridge(): Promise<void> {
  for (const stop of getStoppers()) {
    try {
      stop()
    }
    catch (e) {
      console.warn('[homekit] stopper failed:', e instanceof Error ? e.message : e)
    }
  }
  setStoppers([])

  const b = getBridge()
  if (b) {
    // Split unpublish/destroy: if unpublish throws but destroy still runs to
    // completion the bridge is safely torn down. Clearing the singleton when
    // destroy did NOT complete masks a still-live bridge and causes
    // port-conflict / restart confusion on the next enable().
    try {
      await b.unpublish()
    }
    catch (e) {
      console.warn('[homekit] unpublish failed:', e instanceof Error ? e.message : e)
    }
    let destroyed = false
    try {
      await b.destroy()
      destroyed = true
    }
    catch (e) {
      console.warn('[homekit] destroy failed:', e instanceof Error ? e.message : e)
    }
    if (destroyed) {
      setBridge(null)
      setSetupURI(null)
    }
  }
  else {
    setSetupURI(null)
  }
}

export function getStatus(): BridgeStatus {
  const id = getIdentity()
  return {
    running: getBridge() !== null,
    transitioning: isTransitioning(),
    pincode: id?.pincode ?? null,
    setupId: id?.setupId ?? null,
    setupURI: getSetupURI(),
    username: id?.username ?? null,
    // Read pairings off disk rather than reaching into hap-nodejs's private
    // `_accessoryInfo` field — survives version bumps and works whether or
    // not the bridge is currently published.
    pairedControllers: id ? readPairedControllers(id.username) : [],
  }
}

export async function unpairAll(): Promise<void> {
  // Stop the bridge, drop the persisted pairings, and rotate identity
  // (new MAC + pincode + setupId via HKDF rotation). Re-using the prior
  // AccessoryPairingID strands iOS: the controller retains its pair-verify
  // keys against the same MAC and every read fails encryption forever, so
  // accessories stay "No Response" until manually removed from Home. HAP
  // R2 §5.11 calls for fresh long-term keys on accessory reset and
  // Homebridge rotates the MAC for the same reason (homebridge-config-ui-x
  // resetHomebridgeAccessory).
  const oldUsername = getIdentity()?.username ?? loadOrCreateIdentity().username
  await stopBridge()
  // stopBridge intentionally keeps the singleton live when destroy() fails
  // (port-safety on next enable). Rotating identity in that state would
  // desync getStatus (new MAC) from the live HAP server (still old MAC).
  // Abort instead — operator can retry once the underlying destroy issue
  // clears.
  if (getBridge() !== null) {
    throw new Error('homekit unpair aborted: bridge teardown incomplete (destroy() failed)')
  }
  clearPairings(oldUsername)
  const id = regenerateIdentity()
  setIdentity(id)
}

export async function regenerate(): Promise<ReturnType<typeof loadOrCreateIdentity> | null> {
  // Aligned with unpairAll(): both rotate identity AND clear hap-nodejs
  // pairing state. The split was historical (pre-rotation, regenerate
  // skipped clearPairings); now that unpair rotates the MAC the orphan
  // AccessoryInfo.<old-MAC>.json was unreachable anyway, so we sweep it.
  // tRPC routes remain separate — same effect, different return shape.
  await unpairAll()
  return getIdentity()
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
