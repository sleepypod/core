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
import { clearPairings, hasAccessoryInfo, initHapStorage, loadOrCreateIdentity, markIdentityPaired, readPairedControllers, regenerateIdentity } from './storage'

const BRIDGE_NAME = 'sleepypod'
const BRIDGE_PORT = 51827

// Poll cadence for "have we been paired yet?" — drives the sticky
// wasPaired marker on identity.json that the stranded-bridge detector
// reads on next startBridge. 30s keeps the window between a pair event
// and persistence small enough that a fast-follow iOS unpair → restart
// still gets rotated, without busy-polling the filesystem.
const PAIR_OBSERVE_INTERVAL_MS = 30_000

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

export interface BridgeStatus {
  running: boolean
  pincode: string | null
  setupId: string | null
  setupURI: string | null
  username: string | null
  pairedControllers: string[]
}

export async function startBridge(monitor: DacMonitor): Promise<void> {
  if (getBridge()) return
  initHapStorage()

  let identity = loadOrCreateIdentity()

  // Stranded-bridge detection: bridge was previously paired but
  // pairedClients is now empty. iOS removed the bridge via Home app
  // (HAP pair-remove goes direct to the running server and bypasses
  // unpairAll()) so the rotate-on-reset from PR #566 never fired.
  // Republishing on the same AccessoryPairingID strands iOS (stale
  // pair-verify keys) — same failure mode the prior fix addressed.
  //
  // Two arms:
  //  1. wasPaired marker (new identities) — set by the pair-observe poll
  //     once we see pairedControllers > 0.
  //  2. Legacy identity (pre-ADR-0020, no rotation field) with
  //     AccessoryInfo on disk — wasPaired was never persisted, but the
  //     existence of AccessoryInfo + empty pairings is functionally the
  //     same stranded state. Safe one-shot migration: after rotation the
  //     new identity carries rotation/derivedFrom and won't match again.
  const pairedCount = readPairedControllers(identity.username).length
  const isLegacy = identity.rotation === undefined && identity.derivedFrom === undefined
  const stranded = pairedCount === 0 && (
    identity.wasPaired === true
    || (isLegacy && hasAccessoryInfo(identity.username))
  )
  if (stranded) {
    const reason = identity.wasPaired ? 'wasPaired' : 'legacy-published'
    console.log(`[homekit] stranded bridge detected (${reason}, paired=0) — rotating identity from ${identity.username}`)
    clearPairings(identity.username)
    identity = regenerateIdentity()
  }
  // Eagerly mark the identity as paired if we boot into a populated
  // pairing list. Closes the gap where the bridge process crashed/restarted
  // between pairing and the next 30s poll tick.
  else if (pairedCount > 0 && !identity.wasPaired) {
    markIdentityPaired()
    identity = { ...identity, wasPaired: true }
  }
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
      // Without an explicit bind, ciao on Eight Layer 4.0.2 (Yocto kirkstone,
      // Node 24) bound 5353 successfully but its multicast packets never
      // escaped the pod — observed: avahi sees the service over D-Bus, no
      // host on the LAN gets responses. Binding to the interface name (not
      // an IP) lets ciao track address changes on dhcp and covers both
      // IPv4/IPv6 records. HOMEKIT_BIND env override stays available for
      // dev / non-pod hosts (default falls back to wlan0 only when present).
      bind: pickBind() as never,
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

  // Pair-observe poll: hap-nodejs doesn't expose a pairing-completed
  // event we can hook from outside the server, so we sample the on-disk
  // pairing list and flip the sticky wasPaired marker on the first
  // observation. Once set, the interval self-cancels — no idle work for
  // the long-lived (paired) steady state.
  const pairObserve = setInterval(() => {
    const cur = getIdentity()
    if (!cur) return
    if (cur.wasPaired) {
      clearInterval(pairObserve)
      return
    }
    if (readPairedControllers(cur.username).length > 0) {
      markIdentityPaired()
      setIdentity({ ...cur, wasPaired: true })
      clearInterval(pairObserve)
    }
  }, PAIR_OBSERVE_INTERVAL_MS)
  // Allow the process to exit if this interval is the only thing left.
  pairObserve.unref?.()
  localStoppers.push(() => clearInterval(pairObserve))

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
  await stopBridge()
  const id = regenerateIdentity()
  setIdentity(id)
  return id
}

function pickBind(): string | undefined {
  const env = process.env.HOMEKIT_BIND
  if (env) return env
  // Pod's wifi interface — only set when actually present so dev hosts
  // (macOS / linux laptops) fall back to ciao's default unspecified bind.
  if (existsSync('/sys/class/net/wlan0')) return 'wlan0'
  return undefined
}

function pickAdvertiser(): Advertiser {
  const env = process.env.HOMEKIT_ADVERTISER
  if (env === 'avahi' || env === 'ciao') return env
  // Ciao by default — even when avahi-daemon is running locally. On this
  // pod's avahi build (Eight Layer 4.0.2, Yocto kirkstone, avahi 0.8 with
  // a broken chroot/introspection setup) hap-nodejs's avahi advertiser
  // registers an EntryGroup over D-Bus but never publishes the _hap._tcp
  // service on the wire — bridge boots fine, iOS never discovers it.
  // Ciao binds 5353 with SO_REUSEPORT and coexists with avahi-daemon's
  // static services, so we don't lose the existing _sleepypod._tcp record.
  return ADVERTISER.CIAO
}

function wrapAccessory(name: string, id: string, username: string): Accessory {
  return new Accessory(name, uuid.generate(`sleepypod:${username}:${id}`))
}
