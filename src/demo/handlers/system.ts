import type { DemoHandlers, RouterOutputs } from '../types'
import { DAY, HOUR, MINUTE, hashSeed, seededRandom } from '../util'

type Storage = RouterOutputs['system']['getStorage']
type ReclaimItem = Storage['reclaimable']['items'][number]

const GB = 1024 ** 3
const MB = 1024 ** 2

// Vercel exposes the deploy's commit to the client bundle; fall back for local demo builds.
const COMMIT = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'demo000'
const COMMIT_TITLE = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_MESSAGE?.split('\n')[0] || 'Demo build'
const loadedAt = Date.now()

let internetBlocked = true
let buildDate = new Date(loadedAt - 3 * DAY).toISOString()
let pendingUpdateAt: number | null = null

const LOG_SOURCES = [
  { unit: 'sleepypod.service', name: 'Core' },
  { unit: 'sleepypod-piezo-processor.service', name: 'Piezo Processor' },
  { unit: 'sleepypod-sleep-detector.service', name: 'Sleep Detector' },
  { unit: 'sleepypod-environment-monitor.service', name: 'Environment Monitor' },
]

const LOG_MESSAGES: Record<string, { every: number, lines: string[] }> = {
  'sleepypod.service': {
    every: 47_000,
    lines: [
      '[dac] status poll ok (2 s cadence)',
      '[scheduler] next job: temperature left at 23:30',
      '[temperature] left reconcile: schedule target 68°F',
      '[temperature] right reconcile: schedule target 78°F',
      '[health] sampler tick: 9/9 checks ok',
      '[mqtt] published state (12 topics)',
      '[homekit] accessory state synced',
      '[piezoStream] 1 client connected',
      'WARN [dac] status poll took 1840 ms',
      '[db] integrity quick_check ok (38 ms)',
    ],
  },
  'sleepypod-piezo-processor.service': {
    every: 60_000,
    lines: [
      'INFO left: hr=58 hrv=52 br=14.1 quality=0.91',
      'INFO right: hr=63 hrv=47 br=15.6 quality=0.88',
      'INFO wrote 2 vitals rows',
      'WARN right: motion artifact, window skipped',
    ],
  },
  'sleepypod-sleep-detector.service': {
    every: 90_000,
    lines: [
      'INFO left: present (cap delta 9.4 > 6.0)',
      'INFO right: present (cap delta 8.1 > 6.0)',
      'INFO movement buckets flushed',
      'INFO session open since 23:12',
    ],
  },
  'sleepypod-environment-monitor.service': {
    every: 60_000,
    lines: [
      'INFO bed_temp row written',
      'INFO freezer_temp row written',
      'INFO ambient light 0.4 lux',
      'INFO flow left=28.7 right=28.6 rpm=2402/2398',
    ],
  },
}

const PRIORITY_RANK = { emerg: 0, alert: 1, crit: 2, err: 3, warning: 4, notice: 5, info: 6, debug: 7 } as const

function shortIso(t: number): string {
  const d = new Date(t)
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`
}

function rankOf(message: string): number {
  if (/\b(error|err|fatal)\b/i.test(message)) return PRIORITY_RANK.err
  if (/\bwarn(ing)?\b/i.test(message)) return PRIORITY_RANK.warning
  return PRIORITY_RANK.info
}

const reclaimItems: ReclaimItem[] = [
  { path: '/persistent/sleepypod-releases/2026-09-12T0400Z', bytes: 214 * MB, reason: 'previous release (not current, not newest fallback)', kind: 'release' },
  { path: '/persistent/sleepypod-update-tmp', bytes: 61 * MB, reason: 'leftover update staging', kind: 'temp' },
  { path: '/persistent/sleepypod-data/sleepypod.db.2026-09-20.bak', bytes: 3 * MB, reason: 'database backup older than 7 days', kind: 'backup' },
]
let reclaimable = [...reclaimItems]

function storage(): Storage {
  const segments: Storage['segments'] = [
    { key: 'rawArchive', bytes: 2.6 * GB },
    { key: 'app', bytes: 690 * MB },
    { key: 'database', bytes: 41 * MB },
    { key: 'swap', bytes: 512 * MB },
    { key: 'reclaimable', bytes: reclaimable.reduce((s, i) => s + i.bytes, 0) },
    { key: 'other', bytes: 410 * MB },
  ]
  const totalBytes = 7 * GB
  const usedBytes = Math.round(segments.reduce((s, x) => s + x.bytes, 0))
  return {
    persistent: { totalBytes, usedBytes, availableBytes: totalBytes - usedBytes, usedPercent: Math.round((usedBytes / totalBytes) * 1000) / 10 },
    prunerTargetPercent: 80,
    segments: segments.map(s => ({ ...s, bytes: Math.round(s.bytes) })),
    rawHistory: { fileCount: 168, oldest: new Date(loadedAt - 14 * DAY).toISOString(), newest: new Date(loadedAt - 2 * HOUR).toISOString(), days: 13.9 },
    reclaimable: { available: true, items: reclaimable, totalBytes: reclaimable.reduce((s, i) => s + i.bytes, 0) },
  }
}

export const system: DemoHandlers<'system'> = {
  internetStatus: () => ({ blocked: internetBlocked }),

  setInternetAccess: (input) => {
    internetBlocked = input.blocked
    return { blocked: internetBlocked }
  },

  wifiStatus: () => ({ connected: true, ssid: 'Demo Wi-Fi', signal: 78 }),

  triggerUpdate: (input) => {
    const branch = input.branch ?? 'main'
    // Pretend the pod restarts on a fresh build a few seconds later.
    pendingUpdateAt = Date.now() + 6_000
    return { triggered: true, branch, message: `Update to ${branch} started (demo — nothing is installed)` }
  },

  getLogSources: () => ({ sources: LOG_SOURCES.map(s => ({ ...s, active: true })) }),

  getLogs: (input) => {
    const spec = LOG_MESSAGES[input.unit] ?? LOG_MESSAGES['sleepypod.service']
    const ceiling = input.priority ? PRIORITY_RANK[input.priority] : PRIORITY_RANK.debug
    const lines: string[] = []
    let t = input.cursor ? Number(input.cursor) - spec.every : Math.floor(Date.now() / spec.every) * spec.every
    const floor = Date.now() - 2 * DAY
    while (lines.length < (input.lines ?? 100) && t > floor) {
      const rand = seededRandom(hashSeed(`${input.unit}:${t}`))
      const message = spec.lines[Math.floor(rand() * spec.lines.length)]
      if (rankOf(message) <= ceiling) {
        lines.push(`${shortIso(t)} sleepypod-demo ${input.unit.replace(/\.service$/, '')}[${1200 + (hashSeed(input.unit) % 800)}]: ${message}`)
      }
      t -= spec.every
    }
    return { lines, nextCursor: t > floor ? String(t + spec.every) : null }
  },

  getStorageBreakdown: () => ({
    emmc: { totalBytes: 7 * GB, usedBytes: Math.round(4.6 * GB), availableBytes: Math.round(2.4 * GB), usedPercent: 65.7 },
    biometricsTmpfs: { totalBytes: 256 * MB, usedBytes: 92 * MB, availableBytes: 164 * MB, usedPercent: 35.9 },
    biometricsArchive: { usedBytes: Math.round(2.6 * GB), fileCount: 168 },
  }),

  getStorage: () => storage(),

  freeStorage: (input) => {
    const removed = reclaimable.filter(i => input.includeDbBackups || i.kind !== 'backup')
    reclaimable = reclaimable.filter(i => !removed.includes(i))
    return { freedBytes: removed.reduce((s, i) => s + i.bytes, 0), removed: removed.length }
  },

  getSensorSource: () => {
    const lastFrameAgeMs = 400 + (Date.now() % 1_200)
    return {
      firmware: {
        generation: 'nats',
        label: 'NATS JetStream',
        detail: 'New firmware. Sensor frames arrive over NATS JetStream.',
        expectedTransport: 'nats',
        probed: true,
        signals: {
          natsUnitInstalled: true,
          natsServerActive: true,
          jetstreamDirPresent: true,
          biometricsTmpfsMounted: false,
          frankShimRoutesTmpfs: false,
          frankServiceRoutesTmpfs: false,
        },
      },
      stream: {
        source: 'nats',
        override: null,
        legacyNatsDisabled: false,
        lastFrameAtMs: Date.now() - lastFrameAgeMs,
        lastFrameAgeMs,
        lastFrameType: 'piezo-dual',
        firstFrameMs: 3124,
        uptimeSeconds: Math.floor((Date.now() - DEMO_UPTIME_START) / 1000),
      },
    }
  },

  getVersion: () => {
    if (pendingUpdateAt !== null && Date.now() >= pendingUpdateAt) {
      buildDate = new Date(pendingUpdateAt).toISOString()
      pendingUpdateAt = null
    }
    return { branch: 'demo', commitHash: COMMIT, commitTitle: COMMIT_TITLE, buildDate, version: null }
  },
}

export const DEMO_UPTIME_START = loadedAt - 4 * DAY - 6 * HOUR - 12 * MINUTE
