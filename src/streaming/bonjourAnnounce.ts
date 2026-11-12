/** Local discovery uses a running Avahi daemon, or ciao on Pods without one. */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'
import { loadDiscoveryResponder, type DiscoveryService, type DiscoveryResponder } from './mdnsResponder'

const SERVICE_FILE = '/etc/avahi/services/sleepypod.service'
const STATE_KEY = '__sleepypod_bonjour_lifecycle__'

interface Announcement {
  cancelled: boolean
  started: Promise<void>
  cleanup?: Promise<void>
  avahi: boolean
  service?: DiscoveryService
  responder?: DiscoveryResponder
}

interface Lifecycle {
  current?: Announcement
  stopping: Promise<void>
  desired: boolean
  retry?: ReturnType<typeof setTimeout>
}

// Instrumentation and route bundles can import separate copies of this module.
function lifecycle(): Lifecycle {
  const shared = globalThis as Record<string, unknown>
  return (shared[STATE_KEY] ??= { stopping: Promise.resolve(), desired: false }) as Lifecycle
}

function portNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('Discovery requires valid HTTP and WebSocket ports')
  }
  return Number(value)
}

function avahiProcesses(): number[] {
  try {
    return execFileSync('pidof', ['avahi-daemon'], { encoding: 'utf8', timeout: 1000 })
      .trim().split(/\s+/).filter(value => /^\d+$/.test(value))
      .map(Number).filter(value => Number.isSafeInteger(value) && value > 1)
  }
  catch {
    return []
  }
}

/** A directory or service file alone does not establish that Avahi is running. */
function announceWithAvahi(httpPort: number, websocketPort: number): boolean {
  const processes = avahiProcesses()
  if (processes.length === 0) return false
  const document = `<?xml version="1.0" standalone="no"?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name>sleepypod</name>
  <service>
    <type>_sleepypod._tcp</type>
    <port>${httpPort}</port>
    <txt-record>wsPort=${websocketPort}</txt-record>
    <txt-record>version=1.0.0</txt-record>
  </service>
</service-group>
`
  try {
    if (!existsSync(SERVICE_FILE) || readFileSync(SERVICE_FILE, 'utf8') !== document) {
      mkdirSync('/etc/avahi/services', { recursive: true })
      writeFileSync(SERVICE_FILE, document)
    }
    for (const processId of processes) process.kill(processId, 'SIGHUP')
    return true
  }
  catch (error) {
    console.warn('[bonjour] Avahi configuration unavailable; using ciao:', error)
    return false
  }
}

/** Destroy our service before releasing our reference to HomeKit's shared responder. */
function cleanup(announcement: Announcement): Promise<void> {
  announcement.cleanup ??= (async () => {
    if (announcement.avahi) {
      try {
        unlinkSync(SERVICE_FILE)
        for (const processId of avahiProcesses()) process.kill(processId, 'SIGHUP')
      }
      catch (error) {
        console.warn('[bonjour] Could not withdraw the Avahi service file:', error)
      }
    }
    try {
      await announcement.service?.destroy()
    }
    catch (error) {
      console.warn('[bonjour] Could not withdraw the discovery service:', error)
    }
    try {
      await announcement.responder?.shutdown()
    }
    catch (error) {
      console.warn('[bonjour] Could not release the discovery responder:', error)
    }
  })()
  return announcement.cleanup
}

async function announce(announcement: Announcement, previousStop: Promise<void>): Promise<void> {
  try {
    await previousStop
    if (announcement.cancelled) return
    const httpPort = portNumber(process.env.PORT, 3000)
    const websocketPort = portNumber(process.env.PIEZO_WS_PORT, 3001)
    if (announceWithAvahi(httpPort, websocketPort)) {
      announcement.avahi = true
      console.log(`[bonjour] Advertising _sleepypod._tcp on port ${httpPort} via Avahi`)
      return
    }

    const { getResponder } = loadDiscoveryResponder()
    if (announcement.cancelled) return
    announcement.responder = getResponder()
    announcement.service = announcement.responder.createService({
      name: 'sleepypod',
      type: 'sleepypod',
      hostname: hostname().split('.')[0] || 'sleepypod',
      port: httpPort,
      txt: { wsPort: String(websocketPort), version: '1.0.0' },
    })
    await announcement.service.advertise()
    if (!announcement.cancelled) {
      console.log(`[bonjour] Advertising _sleepypod._tcp on port ${httpPort} via ciao`)
    }
  }
  catch (error) {
    if (!announcement.cancelled) console.warn('[bonjour] Discovery startup failed:', error)
    announcement.cancelled = true
    await cleanup(announcement)
    const state = lifecycle()
    if (state.current === announcement) {
      state.current = undefined
      if (state.desired) {
        state.retry = setTimeout(() => {
          void startBonjourAnnouncement()
        }, 30_000)
        state.retry.unref?.()
      }
    }
  }
}

/** Start once; discovery failures must not stop local routines or hardware service. */
export function startBonjourAnnouncement(): Promise<void> {
  const state = lifecycle()
  if (state.current) return state.current.started
  clearTimeout(state.retry)
  state.retry = undefined
  if (process.env.SLEEPYPOD_MDNS === '0'
    || (process.env.NODE_ENV !== 'production' && process.env.SLEEPYPOD_MDNS !== '1')) {
    state.desired = false
    return Promise.resolve()
  }
  state.desired = true
  const announcement: Announcement = { cancelled: false, avahi: false, started: Promise.resolve() }
  state.current = announcement
  announcement.started = announce(announcement, state.stopping)
  return announcement.started
}

/** Cancel pending publication immediately, then await goodbye packets and cleanup. */
export function stopBonjourAnnouncement(): Promise<void> {
  const state = lifecycle()
  state.desired = false
  clearTimeout(state.retry)
  state.retry = undefined
  const announcement = state.current
  if (!announcement) return state.stopping
  state.current = undefined
  announcement.cancelled = true
  // A cancelled queued start must not discard an earlier in-flight withdrawal.
  state.stopping = Promise.all([state.stopping, cleanup(announcement)]).then(() => {})
  return state.stopping
}
