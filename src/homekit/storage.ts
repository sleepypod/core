/**
 * On-disk storage for HomeKit pairings, accessory identity, and setup code.
 *
 * Persists across next-server restart and sp-update. Lives under
 * /persistent/sleepypod-data/homekit/ in production; falls back to a path
 * under the project root in dev.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { HAPStorage } from 'hap-nodejs'

const PERSISTENT_DIR = '/persistent/sleepypod-data/homekit'
const DEV_DIR = join(process.cwd(), '.homekit-data')

const IDENTITY_FILE = 'identity.json'

interface BridgeIdentity {
  username: string // MAC-format ID
  pincode: string // 8 digits XXX-XX-XXX
  setupId: string // 4 chars
}

let cachedDir: string | null = null

export function getStorageDir(): string {
  if (cachedDir) return cachedDir
  const target = existsSync('/persistent') ? PERSISTENT_DIR : DEV_DIR
  if (!existsSync(target)) mkdirSync(target, { recursive: true })
  cachedDir = target
  return target
}

export function initHapStorage(): void {
  HAPStorage.setCustomStoragePath(getStorageDir())
}

export function loadOrCreateIdentity(): BridgeIdentity {
  const dir = getStorageDir()
  const file = join(dir, IDENTITY_FILE)

  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<BridgeIdentity>
      if (parsed.username && parsed.pincode && parsed.setupId) {
        return parsed as BridgeIdentity
      }
    }
    catch (e) {
      console.warn('[homekit] identity.json unreadable, regenerating:', e instanceof Error ? e.message : e)
    }
  }

  const identity: BridgeIdentity = {
    username: generateUsername(),
    pincode: generatePincode(),
    setupId: generateSetupId(),
  }
  writeFileSync(file, JSON.stringify(identity, null, 2), { mode: 0o600 })
  return identity
}

export function regenerateIdentity(): BridgeIdentity {
  const dir = getStorageDir()
  const file = join(dir, IDENTITY_FILE)
  const identity: BridgeIdentity = {
    username: generateUsername(),
    pincode: generatePincode(),
    setupId: generateSetupId(),
  }
  writeFileSync(file, JSON.stringify(identity, null, 2), { mode: 0o600 })
  return identity
}

function generateUsername(): string {
  const bytes = randomBytes(6)
  // hap-nodejs requires the first byte to be locally administered (bit 1 set).
  bytes[0] = (bytes[0] & 0xFE) | 0x02
  return Array.from(bytes, b => b.toString(16).padStart(2, '0').toUpperCase()).join(':')
}

function generatePincode(): string {
  // Avoid HomeKit-rejected pincodes (000-00-000, 111-11-111, …, 123-45-678).
  const REJECTED = new Set([
    '00000000', '11111111', '22222222', '33333333', '44444444',
    '55555555', '66666666', '77777777', '88888888', '99999999',
    '12345678', '87654321',
  ])
  for (;;) {
    const n = randomBytes(4).readUInt32BE(0) % 100000000
    const padded = n.toString().padStart(8, '0')
    if (!REJECTED.has(padded)) {
      return `${padded.slice(0, 3)}-${padded.slice(3, 5)}-${padded.slice(5)}`
    }
  }
}

function generateSetupId(): string {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = randomBytes(4)
  return Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('')
}
