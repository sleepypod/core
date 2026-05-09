/**
 * On-disk storage for HomeKit pairings, accessory identity, and setup code.
 *
 * Persists across next-server restart and sp-update. Lives under
 * /persistent/sleepypod-data/homekit/ in production; falls back to a path
 * under the project root in dev.
 *
 * Identity is derived deterministically (HKDF over a hardware-rooted seed
 * chain — see ADR 0020) so that wiping /persistent regenerates the same
 * username/pincode/setupId. identity.json is kept as a hot-path cache;
 * existing pods' randomBytes-generated identities are preserved as-is for
 * back-compat (the durability win lands the next time /persistent is
 * wiped, not retroactively).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hkdfSync, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { HAPStorage } from 'hap-nodejs'

const PERSISTENT_DIR = '/persistent/sleepypod-data/homekit'
const DEV_DIR = join(process.cwd(), '.homekit-data')

const IDENTITY_FILE = 'identity.json'

// Salt for the HKDF derivation. Bumping this string forces every pod to
// re-derive identities on next /persistent wipe (or after identity.json
// is removed). Documented escape hatch if a derivation bug ships.
const HKDF_SALT = 'sleepypod-homekit-v1'

// Pincodes HomeKit's spec rejects outright. The deriver loops with an
// attempt counter when one of these falls out, so a benign banned-pincode
// derivation does not abort the bridge.
const REJECTED_PINCODES = new Set([
  '00000000', '11111111', '22222222', '33333333', '44444444',
  '55555555', '66666666', '77777777', '88888888', '99999999',
  '12345678', '87654321',
])

const SETUPID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

// Seed sources, ordered most-stable first. See ADR 0020 for rationale on
// each choice and on why no single source is treated as universal.
type SeedSourceName = 'mmc-cid' | 'mmc-serial' | 'machine-id' | 'random-dev'

interface SeedSourceSpec {
  name: Exclude<SeedSourceName, 'random-dev'>
  path: string
}

const SEED_SOURCES: readonly SeedSourceSpec[] = [
  { name: 'mmc-cid', path: '/sys/block/mmcblk0/device/cid' },
  { name: 'mmc-serial', path: '/sys/block/mmcblk0/device/serial' },
  { name: 'machine-id', path: '/etc/machine-id' },
] as const

interface BridgeIdentity {
  username: string // MAC-format ID
  pincode: string // 8 digits XXX-XX-XXX
  setupId: string // 4 chars
  // Fields below are absent on legacy pre-ADR-0020 identities; new
  // identities written by this module always include them.
  derivedFrom?: SeedSourceName
  derivedAt?: number
  rotation?: number
}

export interface SeedProbeEntry {
  source: SeedSourceName
  path: string | null
  present: boolean
  readable: boolean
  looksDegenerate: boolean
}

export interface SeedProbeResult {
  resolved: SeedSourceName
  sources: SeedProbeEntry[]
}

let cachedDir: string | null = null

export function getStorageDir(): string {
  if (cachedDir) return cachedDir
  const target = existsSync('/persistent') ? PERSISTENT_DIR : DEV_DIR
  if (!existsSync(target)) mkdirSync(target, { recursive: true })
  cachedDir = target
  return target
}

let hapStorageInitialized = false

export function initHapStorage(): void {
  // hap-nodejs throws on a second setCustomStoragePath call. Idempotent
  // so regenerate / disable→enable cycles inside the same process don't
  // blow up.
  if (hapStorageInitialized) return
  HAPStorage.setCustomStoragePath(getStorageDir())
  hapStorageInitialized = true
}

function isDegenerateSeed(value: string): boolean {
  if (!value) return true
  return /^0+$/.test(value) || /^f+$/i.test(value)
}

/**
 * Walk the seed-source chain and return the first usable one. Falls back
 * to a fresh random seed in dev / non-pod environments. The fallback is
 * not durable across `identity.json` deletion — that is intentional;
 * every supported pod ships at least one of mmc-cid / mmc-serial /
 * machine-id, and the dev fallback matches the pre-ADR-0020 behavior.
 */
export function readSeed(): { source: SeedSourceName, value: string } {
  for (const spec of SEED_SOURCES) {
    try {
      const v = readFileSync(spec.path, 'utf8').trim()
      if (!isDegenerateSeed(v)) return { source: spec.name, value: v }
    }
    catch { /* try next */ }
  }
  return { source: 'random-dev', value: randomBytes(32).toString('hex') }
}

/**
 * Read-only diagnostic that reports presence/readability/degeneracy of
 * every chain entry without exposing seed values. Operators run this once
 * per pod variant to verify which source the chain would pick.
 */
export function probeSeedSources(): SeedProbeResult {
  const sources: SeedProbeEntry[] = SEED_SOURCES.map((spec) => {
    let present = false
    let readable = false
    let looksDegenerate = false
    try {
      const v = readFileSync(spec.path, 'utf8').trim()
      present = true
      readable = true
      looksDegenerate = isDegenerateSeed(v)
    }
    catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code
      // ENOENT → file truly absent. EACCES / EPERM → present-but-not-
      // readable, which is its own diagnostic signal.
      present = code !== 'ENOENT'
      readable = false
    }
    return { source: spec.name, path: spec.path, present, readable, looksDegenerate }
  })

  const usable = sources.find(s => s.readable && !s.looksDegenerate)
  return {
    resolved: usable?.source ?? 'random-dev',
    sources: [
      ...sources,
      { source: 'random-dev', path: null, present: true, readable: true, looksDegenerate: false },
    ],
  }
}

function derive(seed: string, label: string, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', seed, HKDF_SALT, label, length))
}

function deriveUsername(seed: string, rotation: number): string {
  const bytes = derive(seed, `username/${rotation}`, 6)
  // hap-nodejs requires the first byte to be locally administered (bit 1 set).
  bytes[0] = (bytes[0] & 0xFE) | 0x02
  return Array.from(bytes, b => b.toString(16).padStart(2, '0').toUpperCase()).join(':')
}

function derivePincode(seed: string, rotation: number): string {
  // Bounded retry: HomeKit's banned set is small; any random-looking
  // input produces a valid pincode within a couple of attempts. A budget
  // of 32 makes a degenerate seed surface as a thrown error rather than
  // an infinite loop.
  for (let attempt = 0; attempt < 32; attempt++) {
    const bytes = derive(seed, `pincode/${rotation}/${attempt}`, 4)
    const n = bytes.readUInt32BE(0) % 100_000_000
    const padded = n.toString().padStart(8, '0')
    if (!REJECTED_PINCODES.has(padded)) {
      return `${padded.slice(0, 3)}-${padded.slice(3, 5)}-${padded.slice(5)}`
    }
  }
  throw new Error('homekit pincode derivation exhausted retry budget')
}

function deriveSetupId(seed: string, rotation: number): string {
  const bytes = derive(seed, `setupid/${rotation}`, 4)
  return Array.from(bytes, b => SETUPID_ALPHABET[b % SETUPID_ALPHABET.length]).join('')
}

function newIdentity(rotation: number): BridgeIdentity {
  const seed = readSeed()
  const identity: BridgeIdentity = {
    username: deriveUsername(seed.value, rotation),
    pincode: derivePincode(seed.value, rotation),
    setupId: deriveSetupId(seed.value, rotation),
    derivedFrom: seed.source,
    derivedAt: Math.floor(Date.now() / 1000),
    rotation,
  }
  return identity
}

function writeIdentity(identity: BridgeIdentity): void {
  const file = join(getStorageDir(), IDENTITY_FILE)
  writeFileSync(file, JSON.stringify(identity, null, 2), { mode: 0o600 })
}

export function loadOrCreateIdentity(): BridgeIdentity {
  const dir = getStorageDir()
  const file = join(dir, IDENTITY_FILE)

  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<BridgeIdentity>
      if (parsed.username && parsed.pincode && parsed.setupId) {
        // Legacy randomBytes identities (pre-ADR-0020) lack derivedFrom
        // / rotation. Preserve them as-is so existing pods don't get
        // re-derived under the user — that would force a Home app re-add
        // for everyone on upgrade.
        return parsed as BridgeIdentity
      }
    }
    catch (e) {
      console.warn('[homekit] identity.json unreadable, regenerating:', e instanceof Error ? e.message : e)
    }
  }

  const identity = newIdentity(0)
  writeIdentity(identity)
  console.log(`[homekit] derived identity from ${identity.derivedFrom} (rotation=${identity.rotation})`)
  return identity
}

function pairedFilePath(username: string): string {
  const key = username.replace(/:/g, '').toUpperCase()
  return join(getStorageDir(), `AccessoryInfo.${key}.json`)
}

/**
 * Read the controller pairings hap-nodejs persisted under
 * AccessoryInfo.<username>.json. Avoids reaching into the running
 * Bridge's private `_accessoryInfo` field.
 */
export function readPairedControllers(username: string): string[] {
  const file = pairedFilePath(username)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { pairedClients?: Record<string, unknown> }
    return Object.keys(parsed.pairedClients ?? {})
  }
  catch {
    return []
  }
}

/**
 * Remove hap-nodejs persisted pairing state for `username` while keeping
 * identity.json (username/pincode/setupId) intact, so the bridge republishes
 * with the same accessory identity but no controller pairings.
 *
 * File naming matches hap-nodejs: AccessoryInfo.<USERNAME>.json and
 * IdentifierCache.<USERNAME>.json with colons stripped, uppercase.
 */
export function clearPairings(username: string): void {
  const dir = getStorageDir()
  const key = username.replace(/:/g, '').toUpperCase()
  for (const name of [`AccessoryInfo.${key}.json`, `IdentifierCache.${key}.json`]) {
    rmSync(join(dir, name), { force: true })
  }
}

/**
 * Force a fresh derivation. Bumps the per-identity rotation counter so
 * the resulting username/pincode/setupId differ from the previous ones
 * even if the seed source is unchanged (the production case). Loss of
 * /persistent after a regenerate falls back to rotation=0 — the user's
 * explicit "regenerate" action is not durable across wipes by design;
 * if they want stable identity, they should not regenerate.
 */
export function regenerateIdentity(): BridgeIdentity {
  const dir = getStorageDir()
  const file = join(dir, IDENTITY_FILE)

  let prevRotation = -1
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<BridgeIdentity>
      if (typeof parsed.rotation === 'number' && Number.isFinite(parsed.rotation)) {
        prevRotation = parsed.rotation
      }
    }
    catch { /* treat as no prior rotation */ }
  }

  const identity = newIdentity(prevRotation + 1)
  writeIdentity(identity)
  return identity
}
