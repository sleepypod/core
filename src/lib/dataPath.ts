/**
 * The pod's data path as System → Health draws it: sensors → hardware →
 * services → core → outputs. Each stage is judged by whether its OUTPUT is
 * fresh, not only whether its process is running — a module can be "active"
 * in systemd for hours while writing nothing (the stalled-vitals case that
 * showed every process check green).
 *
 * Pure: the server collects `DataPathInputs` (see dataPathCollect.ts) and this
 * module turns them into node statuses, edge states and one verdict, so the
 * same evaluation feeds the live map and the once-a-minute history sampler.
 */

export type CheckStatus = 'ok' | 'idle' | 'stale' | 'down' | 'unknown'
export type Stage = 'sensors' | 'hardware' | 'services' | 'core' | 'outputs'
export type Side = 'left' | 'right'

export const STAGES: ReadonlyArray<{ id: Stage, label: string }> = [
  { id: 'sensors', label: 'Sensors' },
  { id: 'hardware', label: 'Hardware' },
  { id: 'services', label: 'Services' },
  { id: 'core', label: 'Core' },
  { id: 'outputs', label: 'Outputs' },
]

export type NodeId
  = | 'sensor-piezo' | 'sensor-cap' | 'sensor-temp'
    | 'frames' | 'dac'
    | 'piezo-processor' | 'sleep-detector' | 'environment-monitor' | 'dac-monitor'
    | 'database' | 'scheduler'
    | 'out-vitals' | 'out-sleep' | 'out-temp' | 'out-live'

/** Module units System → Health may restart (sudoers allows exactly these). */
export const RESTARTABLE_UNITS = [
  'sleepypod-piezo-processor.service',
  'sleepypod-sleep-detector.service',
  'sleepypod-environment-monitor.service',
] as const
export type RestartableUnit = (typeof RESTARTABLE_UNITS)[number]

export const NODES: ReadonlyArray<{ id: NodeId, stage: Stage, label: string, unit?: RestartableUnit }> = [
  { id: 'sensor-piezo', stage: 'sensors', label: 'Piezo' },
  { id: 'sensor-cap', stage: 'sensors', label: 'Capacitance' },
  { id: 'sensor-temp', stage: 'sensors', label: 'Temperature' },
  { id: 'frames', stage: 'hardware', label: 'Frame source' },
  { id: 'dac', stage: 'hardware', label: 'DAC socket' },
  { id: 'piezo-processor', stage: 'services', label: 'Piezo processor', unit: 'sleepypod-piezo-processor.service' },
  { id: 'sleep-detector', stage: 'services', label: 'Sleep detector', unit: 'sleepypod-sleep-detector.service' },
  { id: 'environment-monitor', stage: 'services', label: 'Environment monitor', unit: 'sleepypod-environment-monitor.service' },
  { id: 'dac-monitor', stage: 'services', label: 'DAC monitor' },
  { id: 'database', stage: 'core', label: 'Database' },
  { id: 'scheduler', stage: 'core', label: 'Scheduler' },
  { id: 'out-vitals', stage: 'outputs', label: 'Vitals' },
  { id: 'out-sleep', stage: 'outputs', label: 'Sleep sessions' },
  { id: 'out-temp', stage: 'outputs', label: 'Bed temperature' },
  { id: 'out-live', stage: 'outputs', label: 'Live stream' },
]

/**
 * `carries` names the node whose output the link transports: the link from
 * the database to Vitals moves only while the piezo processor is writing.
 */
export const EDGES: ReadonlyArray<{ from: NodeId, to: NodeId, carries: NodeId }> = [
  { from: 'sensor-piezo', to: 'frames', carries: 'sensor-piezo' },
  { from: 'sensor-cap', to: 'frames', carries: 'sensor-cap' },
  { from: 'sensor-temp', to: 'frames', carries: 'sensor-temp' },
  { from: 'frames', to: 'piezo-processor', carries: 'sensor-piezo' },
  { from: 'frames', to: 'sleep-detector', carries: 'sensor-cap' },
  { from: 'frames', to: 'environment-monitor', carries: 'sensor-temp' },
  { from: 'dac', to: 'dac-monitor', carries: 'dac' },
  { from: 'piezo-processor', to: 'database', carries: 'piezo-processor' },
  { from: 'sleep-detector', to: 'database', carries: 'sleep-detector' },
  { from: 'environment-monitor', to: 'database', carries: 'environment-monitor' },
  { from: 'dac-monitor', to: 'database', carries: 'dac-monitor' },
  { from: 'database', to: 'out-vitals', carries: 'piezo-processor' },
  { from: 'database', to: 'out-sleep', carries: 'sleep-detector' },
  { from: 'database', to: 'out-temp', carries: 'environment-monitor' },
  { from: 'dac-monitor', to: 'out-temp', carries: 'dac-monitor' },
  { from: 'scheduler', to: 'out-temp', carries: 'scheduler' },
  { from: 'frames', to: 'out-live', carries: 'frames' },
]

/** After the core starts, frames have this long to arrive before silence counts as a stall. */
export const FRAME_GRACE_MS = 2 * 60_000

/** Output older than this (while output is expected) is stale. */
export const STALE_AFTER_MS = {
  // piezo-dual streams at ~2 Hz, capSense2 ~2 Hz; firmware never pauses them.
  'sensor-piezo': 60_000,
  'sensor-cap': 60_000,
  // bedTemp / frzTemp arrive every few seconds to a minute depending on pod.
  'sensor-temp': 5 * 60_000,
  'frames': 60_000,
  // Polls every 1–5 s.
  'dac-monitor': 60_000,
  // Vitals and movement land about once a minute while someone is in bed.
  'piezo-processor': 15 * 60_000,
  'sleep-detector': 15 * 60_000,
  // bed_temp / freezer_temp are downsampled to one row a minute.
  'environment-monitor': 10 * 60_000,
} as const satisfies Partial<Record<NodeId, number>>
type FreshnessChecked = keyof typeof STALE_AFTER_MS

export interface DataPathInputs {
  now: number
  /** systemd is-active per module unit; null when systemctl isn't available (dev). */
  units: Record<RestartableUnit, boolean | null>
  /** Epoch ms each live frame type was last received, from the core's stream. */
  frameTimes: Record<string, number>
  sensorSource: 'pending' | 'raw' | 'nats'
  /** How long the core has been up; frames get a grace period after start. */
  coreUptimeMs: number
  dacSocket: { ok: boolean, latencyMs: number, error?: string }
  dacMonitor: { status: string, lastPollAt: number | null, pollIntervalMs?: number | null }
  database: { ok: boolean, latencyMs: number, error?: string }
  scheduler: { enabled: boolean, jobs: number, healthy: boolean }
  occupied: Record<Side, boolean>
  /**
   * Sleep-detector output over the last STILL_WINDOW_MS per side: how many
   * movement rows it wrote (one a minute while it holds a session open) and
   * the largest score among them.
   */
  stillness: Record<Side, { rows: number, maxScore: number }>
  lastVitalAt: Record<Side, number | null>
  lastMovementAt: Record<Side, number | null>
  lastEnvAt: number | null
  thermal: Array<{ side: Side, verdict: 'off' | 'delivering' | 'holding' | 'stalled' | 'unknown' }>
  streamClients: number | null
  /** Port of the browser WebSocket stream. */
  streamPort?: number
}

export interface NodeState {
  id: NodeId
  stage: Stage
  label: string
  status: CheckStatus
  /** One live metric under the label: "2s ago", "4 ms", "3h 56m ago". */
  metric: string
  /** Plain-words explanation of the status. */
  detail: string
  /** Epoch ms of the newest output this stage produced, when it has one. */
  lastOutputAt: number | null
  unit?: RestartableUnit
  /** Where the stage lives, for the inspector: a unit, socket or port. */
  path?: string
}

export type EdgeState = 'flowing' | 'idle' | 'stalled'

export interface Verdict {
  tone: 'ok' | 'warn' | 'danger'
  headline: string
  /** The broken stage furthest upstream — where the chain breaks. */
  nodeId: NodeId | null
  /** The last stage upstream of the break that still has data. */
  lastGoodId: NodeId | null
  fix: Fix | null
  /** Other independent breaks, e.g. "DAC socket down". */
  also: string[]
}

export type Fix
  = | { kind: 'restart', unit: RestartableUnit, label: string }
    // Only a person can tell an empty bed with a drifted reading from a sleeper whose vitals stopped.
    | { kind: 'occupancy', sides: Side[], unit: RestartableUnit, label: string }
    | { kind: 'logs', unit: string, label: string, hint?: string }
    | { kind: 'link', tab: 'scheduler' | 'thermal', label: string }

/** empty · occupied · suspect (reads occupied, but no vitals or restless movement for hours). */
export type OccupancyRead = 'empty' | 'occupied' | 'suspect'

export interface DataPathState {
  at: number
  occupancy: Record<Side, OccupancyRead>
  nodes: NodeState[]
  edges: Array<{ from: NodeId, to: NodeId, state: EdgeState }>
  verdict: Verdict
}

/** How long a side may read occupied with no vitals or restless movement before it's suspect. */
export const STILL_WINDOW_MS = 2 * 3_600_000
/**
 * Movement below this is noise, not a body turning over: the sleep detector
 * writes small scores for a still sleeper and for ~10 min after it restarts.
 * Matches RESTLESS_SCORE_MIN in src/lib/movement.
 */
const RESTLESS_SCORE = 50
/**
 * Movement rows the sleep detector must have written in the window — one a
 * minute during a session — so a session opened minutes ago isn't judged.
 */
const STILL_MIN_ROWS = 100

const SIDES: Side[] = ['left', 'right']
const NODE_DEFS = new Map(NODES.map(n => [n.id, n]))

function mustGet<K, V>(map: Map<K, V>, key: K): V {
  const v = map.get(key)
  if (v === undefined) throw new Error(`data path: unknown node ${String(key)}`)
  return v
}

/** "2s ago" · "14m ago" · "3h 56m ago" · "2d ago". */
export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m ago`
  return `${Math.floor(h / 24)}d ago`
}

/** Poll cadence: "1s", "2s", "500ms". */
function fmtInterval(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 100) / 10}s`
}

function latest(...ts: Array<number | null | undefined>): number | null {
  const vals = ts.filter((t): t is number => t != null)
  return vals.length ? Math.max(...vals) : null
}

/**
 * Freshness of one producer: down when its process isn't running, otherwise
 * stale when output is expected but older than its threshold.
 */
function freshness(opts: {
  alive: boolean | null
  lastOutputAt: number | null
  expecting: boolean
  staleAfterMs: number
  now: number
}): CheckStatus {
  const { alive, lastOutputAt, expecting, staleAfterMs, now } = opts
  if (alive === false) return 'down'
  if (!expecting) return alive == null && lastOutputAt == null ? 'unknown' : 'idle'
  if (lastOutputAt != null && now - lastOutputAt <= staleAfterMs) return 'ok'
  // Expected but nothing fresh. Without a process signal and no output ever,
  // we can't tell a dev box from a broken pod.
  if (alive == null && lastOutputAt == null) return 'unknown'
  return 'stale'
}

function unitWord(alive: boolean | null): string {
  return alive === true ? 'running' : alive === false ? 'not running' : 'process state unknown'
}

export function evaluateDataPath(i: DataPathInputs): DataPathState {
  const { now } = i
  // A capacitance level stuck above a drifted empty-bed baseline reads as a
  // sleeper who never produces a heartbeat — and so does a real sleeper whose
  // vitals pipeline stopped. Hours of "occupied" with no vitals and no
  // restless movement is suspect: only someone at the bed can say which.
  const occupancy = Object.fromEntries(SIDES.map((s) => {
    if (!i.occupied[s]) return [s, 'empty']
    const still = i.stillness[s]
    const vitalsQuiet = i.lastVitalAt[s] == null || now - (i.lastVitalAt[s] as number) > STILL_WINDOW_MS
    const suspect = still.rows >= STILL_MIN_ROWS && still.maxScore < RESTLESS_SCORE && vitalsQuiet
    return [s, suspect ? 'suspect' : 'occupied']
  })) as Record<Side, OccupancyRead>
  const suspectSides = SIDES.filter(s => occupancy[s] === 'suspect')
  const occupiedSides = SIDES.filter(s => occupancy[s] === 'occupied')
  const anyOccupied = occupiedSides.length > 0
  const ago = (t: number | null) => (t == null ? 'no data yet' : fmtAgo(now - t))
  const nodes = new Map<NodeId, NodeState>()
  const node = (id: NodeId) => mustGet(nodes, id)
  const put = (id: NodeId, status: CheckStatus, metric: string, detail: string, lastOutputAt: number | null = null, path?: string) => {
    const def = mustGet(NODE_DEFS, id)
    const where = path ?? nodes.get(id)?.path ?? def.unit
    nodes.set(id, { id, stage: def.stage, label: def.label, status, metric, detail, lastOutputAt, ...(def.unit && { unit: def.unit }), ...(where && { path: where }) })
  }

  // ── Sensors: judged by live frames reaching the core ──
  const frameAt = (...types: string[]) => latest(...types.map(t => i.frameTimes[t]))
  const sourceUp = i.sensorSource !== 'pending'
  // Once the source has had time to deliver, silence is a stall, not "unknown".
  const sourceAlive = !sourceUp ? false : i.coreUptimeMs > FRAME_GRACE_MS ? true : null
  const sensor = (id: FreshnessChecked, types: string[], what: string) => {
    const at = frameAt(...types)
    const status = freshness({ alive: sourceAlive, lastOutputAt: at, expecting: true, staleAfterMs: STALE_AFTER_MS[id], now })
    const detail = status === 'ok'
      ? `${what[0].toUpperCase()}${what.slice(1)} frames arriving`
      : status === 'unknown'
        ? 'Waiting for the first frames'
        : status === 'down'
          ? 'No frame source connected yet'
          : at == null ? `No ${what} frames since the core started` : `No ${what} frames for ${fmtAgo(now - at).replace(' ago', '')}`
    put(id, status, ago(at), detail, at)
  }
  sensor('sensor-piezo', ['piezo-dual'], 'piezo')
  sensor('sensor-cap', ['capSense2', 'capSense'], 'capacitance')
  sensor('sensor-temp', ['bedTemp2', 'bedTemp', 'frzTemp', 'frzTherm'], 'temperature')

  // ── Hardware ──
  const anyFrameAt = frameAt('piezo-dual', 'capSense2', 'capSense', 'bedTemp2', 'bedTemp', 'frzTemp', 'frzTherm')
  const framesStatus = freshness({ alive: sourceAlive, lastOutputAt: anyFrameAt, expecting: true, staleAfterMs: STALE_AFTER_MS.frames, now })
  put(
    'frames',
    framesStatus,
    sourceUp ? `${i.sensorSource === 'nats' ? 'NATS' : 'RAW'} · ${ago(anyFrameAt)}` : 'discovering',
    framesStatus === 'ok'
      ? `Reading ${i.sensorSource === 'nats' ? 'the firmware’s NATS stream' : '.RAW files from the firmware'}`
      : framesStatus === 'down'
        ? 'Still choosing between .RAW files and NATS'
        : framesStatus === 'unknown' ? 'Waiting for the first frames' : 'Connected, but no frames are arriving',
    anyFrameAt,
  )
  put(
    'dac',
    i.dacSocket.ok ? 'ok' : 'down',
    i.dacSocket.ok ? `dac.sock · ${Math.max(1, Math.round(i.dacSocket.latencyMs))} ms` : 'unreachable',
    i.dacSocket.ok ? 'Firmware control socket answers' : `Can’t connect to dac.sock${i.dacSocket.error ? `: ${i.dacSocket.error}` : ''}`,
    null,
    'dac.sock',
  )

  // ── Services ──
  const inBedWorst = (per: Record<Side, number | null>) => {
    // The side that has gone longest without output decides.
    if (!anyOccupied) return latest(...SIDES.map(s => per[s]))
    const vals = occupiedSides.map(s => per[s])
    return vals.some(v => v == null) ? null : Math.min(...(vals as number[]))
  }
  const whoInBed = occupiedSides.length === 2 ? 'Both sides in bed' : occupiedSides.length === 1 ? `${occupiedSides[0] === 'left' ? 'Left' : 'Right'} side in bed` : 'Bed empty'

  const moduleNode = (id: FreshnessChecked, unit: RestartableUnit, lastOutputAt: number | null, expecting: boolean, output: string) => {
    const alive = i.units[unit]
    const status = freshness({ alive, lastOutputAt, expecting, staleAfterMs: STALE_AFTER_MS[id], now })
    const detail = status === 'down'
      ? `Service not running`
      : status === 'unknown'
        ? `Can’t tell: no process state and no ${output} written yet`
        : status === 'stale'
          ? `${whoInBed} · ${unitWord(alive)}, but ${lastOutputAt == null ? `has written no ${output}` : `last ${output} ${fmtAgo(now - lastOutputAt)}`}`
          : status === 'idle'
            ? `${unitWord(alive)} · ${whoInBed.toLowerCase()}, no ${output} expected`
            : `${unitWord(alive)} · writing ${output}`
    put(id, status, lastOutputAt == null ? 'no output yet' : `last ${ago(lastOutputAt)}`, detail[0].toUpperCase() + detail.slice(1), lastOutputAt)
  }
  moduleNode('piezo-processor', 'sleepypod-piezo-processor.service', inBedWorst(i.lastVitalAt), anyOccupied, 'vitals')
  moduleNode('sleep-detector', 'sleepypod-sleep-detector.service', inBedWorst(i.lastMovementAt), anyOccupied, 'movement')
  if (suspectSides.length > 0 && node('sleep-detector').status !== 'down') {
    const who = suspectSides.length === 2 ? 'Both sides read' : `${suspectSides[0] === 'left' ? 'Left' : 'Right'} side reads`
    const quietSince = suspectSides.map(s => i.lastVitalAt[s]).some(t => t == null) ? null : Math.min(...suspectSides.map(s => i.lastVitalAt[s] as number))
    const span = quietSince == null ? 'over 2 hours' : fmtAgo(now - quietSince).replace(' ago', '')
    const sd = node('sleep-detector')
    put('sleep-detector', 'stale', sd.metric, `${who} occupied, but no vitals or movement for ${span} — either nobody is there and the empty-bed reading is off, or vitals are stuck`, sd.lastOutputAt)
    // Vitals can't be judged until someone says whether the side is empty.
    const pz = node('piezo-processor')
    if (pz.status === 'idle') put('piezo-processor', 'unknown', pz.metric, `No vitals from a side that reads occupied — can’t tell yet whether anyone is there`, pz.lastOutputAt)
  }
  moduleNode('environment-monitor', 'sleepypod-environment-monitor.service', i.lastEnvAt, true, 'bed temperature')

  // degraded = lost the socket; stopped / not_initialized = never polling.
  const monitorAlive = i.dacMonitor.status === 'running' || i.dacMonitor.status === 'starting'
  // Before its first poll lands, a freshly started monitor isn't stalled yet.
  const firstPollPending = monitorAlive && i.dacMonitor.lastPollAt == null && i.coreUptimeMs <= FRAME_GRACE_MS
  const monitorStatus = firstPollPending
    ? 'unknown'
    : freshness({ alive: monitorAlive, lastOutputAt: i.dacMonitor.lastPollAt, expecting: true, staleAfterMs: STALE_AFTER_MS['dac-monitor'], now })
  put(
    'dac-monitor',
    monitorStatus,
    i.dacMonitor.lastPollAt == null
      ? i.dacMonitor.status.replace('_', ' ')
      : i.dacMonitor.pollIntervalMs ? `polls ${fmtInterval(i.dacMonitor.pollIntervalMs)} · ${ago(i.dacMonitor.lastPollAt)}` : `polled ${ago(i.dacMonitor.lastPollAt)}`,
    monitorStatus === 'ok'
      ? 'Polling device status'
      : monitorStatus === 'down'
        ? `Monitor ${i.dacMonitor.status.replace('_', ' ')}`
        : monitorStatus === 'unknown' ? 'Waiting for the first poll' : 'Running, but polls have stopped succeeding',
    i.dacMonitor.lastPollAt,
    i.dacMonitor.pollIntervalMs ? `DacMonitor · polls every ${fmtInterval(i.dacMonitor.pollIntervalMs)}` : 'DacMonitor',
  )

  // ── Core ──
  put('database', i.database.ok ? 'ok' : 'down', i.database.ok ? `${Math.max(1, Math.round(i.database.latencyMs))} ms` : 'error', i.database.ok ? 'Answering queries' : i.database.error ?? 'Query failed')
  const schedStatus: CheckStatus = !i.scheduler.enabled ? 'idle' : i.scheduler.healthy ? 'ok' : 'stale'
  put(
    'scheduler',
    schedStatus,
    i.scheduler.enabled ? `${i.scheduler.jobs} jobs` : 'disabled',
    !i.scheduler.enabled ? 'Scheduling is turned off' : i.scheduler.healthy ? 'Jobs loaded' : 'Enabled, but no jobs loaded — schedules failed to load',
  )

  // ── Outputs: mirror the stage that feeds them ──
  const mirror = (id: NodeId, source: NodeId, idleWord: string) => {
    const src = node(source)
    const status: CheckStatus = src.status === 'down' ? 'stale' : src.status
    put(
      id,
      status,
      src.lastOutputAt == null ? '—' : ago(src.lastOutputAt),
      status === 'ok' ? 'Up to date' : status === 'idle' ? idleWord : status === 'unknown' ? 'Can’t tell yet' : `Not updating — ${src.label.toLowerCase()} ${src.status === 'down' ? 'is down' : 'stopped writing'}`,
      src.lastOutputAt,
    )
  }
  mirror('out-vitals', 'piezo-processor', 'Waiting for someone to get in bed')
  mirror('out-sleep', 'sleep-detector', 'Waiting for someone to get in bed')
  if (suspectSides.length > 0 && node('out-sleep').status === 'stale' && node('sleep-detector').status !== 'down') {
    const o = node('out-sleep')
    put('out-sleep', 'stale', o.metric, 'Holding a session open for a side that looks empty', o.lastOutputAt)
  }

  const stalledSides = i.thermal.filter(t => t.verdict === 'stalled').map(t => t.side)
  const env = node('environment-monitor')
  const mon = node('dac-monitor')
  const tempStatus: CheckStatus = stalledSides.length > 0 || BROKEN.has(mon.status)
    ? 'stale'
    : mon.status === 'unknown' || env.status === 'unknown' ? 'unknown' : env.status === 'ok' ? 'ok' : 'stale'
  const sideWord = (t: DataPathInputs['thermal'][number]) => `${t.side === 'left' ? 'L' : 'R'} ${t.verdict}`
  put(
    'out-temp',
    tempStatus,
    i.thermal.length ? i.thermal.map(sideWord).join(' · ') : '—',
    stalledSides.length > 0
      ? `Powered but the pump isn’t circulating on the ${stalledSides.join(' and ')} side`
      : tempStatus === 'ok' ? 'Readings and control up to date' : mon.status !== 'ok' ? 'Device status isn’t updating' : 'Bed temperature readings aren’t updating',
    env.lastOutputAt,
  )

  const liveStatus: CheckStatus = i.streamClients == null ? 'down' : node('frames').status === 'ok' ? (i.streamClients > 0 ? 'ok' : 'idle') : 'stale'
  const wsPort = i.streamPort == null ? 'WS' : `WS :${i.streamPort}`
  put(
    'out-live',
    liveStatus,
    i.streamClients == null ? 'stopped' : `${wsPort} · ${i.streamClients} ${i.streamClients === 1 ? 'viewer' : 'viewers'}`,
    liveStatus === 'down' ? 'WebSocket server isn’t running' : liveStatus === 'stale' ? 'No frames to stream' : liveStatus === 'idle' ? 'Ready, nobody watching' : 'Streaming to browsers',
    null,
    `broadcastFrame() → WebSocket${i.streamPort == null ? '' : ` :${i.streamPort}`} → ${i.streamClients ?? 0} ${i.streamClients === 1 ? 'browser' : 'browsers'}`,
  )

  const ordered = NODES.map(n => node(n.id))
  const edges = EDGES.map(e => ({ from: e.from, to: e.to, state: edgeState(node(e.carries).status) }))
  return { at: now, occupancy, nodes: ordered, edges, verdict: verdictOf(ordered, now, suspectSides) }
}

function edgeState(s: CheckStatus): EdgeState {
  if (s === 'ok') return 'flowing'
  if (s === 'stale' || s === 'down') return 'stalled'
  return 'idle'
}

const BROKEN: ReadonlySet<CheckStatus> = new Set(['stale', 'down'])

function upstreamOf(id: NodeId): NodeId[] {
  return EDGES.filter(e => e.to === id && e.carries !== id).map(e => e.from)
}

/**
 * Where the chain breaks: the most upstream broken stage whose own inputs are
 * healthy. Downstream stages that are stale only because of it are symptoms.
 */
export function verdictOf(nodes: NodeState[], now: number, suspectSides: Side[] = []): Verdict {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const broken = nodes.filter(n => BROKEN.has(n.status))
  if (broken.length === 0) {
    const idle = nodes.filter(n => n.stage === 'services' && n.status === 'idle')
    return {
      tone: 'ok',
      headline: idle.length > 0
        ? 'Data is flowing from the sensors to every output. Vitals and sleep tracking are idle until someone gets in bed.'
        : 'Data is flowing from the sensors to every output.',
      nodeId: null,
      lastGoodId: null,
      fix: null,
      also: [],
    }
  }

  const isCause = (n: NodeState) => upstreamOf(n.id).every(u => !BROKEN.has(mustGet(byId, u).status))
  const stageRank = (n: NodeState) => STAGES.findIndex(s => s.id === n.stage)
  // Prefer non-output causes; outputs only break on their own when nothing feeds them wrongly.
  const causes = broken.filter(isCause).sort((a, b) => stageRank(a) - stageRank(b))
  const cause = causes[0] ?? broken[0]
  const lastGood = upstreamOf(cause.id).map(u => mustGet(byId, u)).find(u => u.status === 'ok') ?? null
  const affected = downstreamOf(cause.id)
  const outputs = nodes.filter(n => n.stage === 'outputs' && BROKEN.has(n.status) && affected.has(n.id))
  // Independent problems elsewhere on the path, named so a fix to the first
  // doesn't read as "all clear".
  const also = causes.slice(1).filter(n => !affected.has(n.id)).map(n => `${n.label} ${n.status === 'down' ? 'down' : 'stalled'}`)

  // The sleep detector is "stale" here because its occupancy reading is
  // wrong, not because it stopped: the fix is a fresh empty-bed reading.
  const phantom = cause.id === 'sleep-detector' && cause.status === 'stale' && suspectSides.length > 0
  return {
    tone: cause.status === 'down' || cause.stage === 'sensors' ? 'danger' : 'warn',
    headline: phantom ? `${cause.detail.split(' — ')[0]}. Is anyone there?` : headlineFor(cause, outputs, now),
    nodeId: cause.id,
    lastGoodId: lastGood?.id ?? null,
    fix: phantom
      ? { kind: 'occupancy', sides: suspectSides, unit: 'sleepypod-piezo-processor.service', label: 'Is anyone there?' }
      : fixFor(cause),
    also,
  }
}

/** Stages whose data passes through `id`: follow links that carry its output onward. */
function downstreamOf(id: NodeId): Set<NodeId> {
  const reached = new Set<NodeId>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const e of EDGES) {
      if (reached.has(e.from) && reached.has(e.carries) && !reached.has(e.to)) {
        reached.add(e.to)
        grew = true
      }
    }
  }
  return reached
}

function headlineFor(cause: NodeState, outputs: NodeState[], now: number): string {
  const affected = outputs.map(o => o.label.toLowerCase())
  const since = cause.lastOutputAt != null ? ` ${fmtAgo(now - cause.lastOutputAt).replace(' ago', '')} ago` : ''
  switch (cause.id) {
    case 'piezo-processor':
      return cause.status === 'down'
        ? 'Vitals stopped: the piezo processor isn’t running.'
        : `Vitals stopped${since}: the piezo processor is running but has written nothing while the bed is occupied.`
    case 'sleep-detector':
      return cause.status === 'down'
        ? 'Sleep tracking stopped: the sleep detector isn’t running.'
        : `Sleep tracking stopped${since}: the sleep detector is running but has written nothing while the bed is occupied.`
    case 'environment-monitor':
      return cause.status === 'down'
        ? 'Bed temperature history stopped: the environment monitor isn’t running.'
        : `Bed temperature history stopped${since}: the environment monitor is running but writing nothing.`
    case 'sensor-piezo':
    case 'sensor-cap':
    case 'sensor-temp':
    case 'frames':
      return `No ${cause.id === 'frames' ? 'sensor' : cause.label.toLowerCase()} frames are reaching the pod’s software${since ? ` (last${since})` : ''}. ${affected.length ? `${capitalizeList(affected)} can’t update until they return.` : ''}`.trim()
    case 'dac':
      return 'The firmware control socket isn’t answering, so the pod can’t read or change the bed.'
    case 'dac-monitor':
      return 'Device status stopped updating: the DAC monitor isn’t polling the firmware.'
    case 'database':
      return 'The database isn’t answering queries.'
    case 'scheduler':
      return 'The scheduler is on but has no jobs loaded, so schedules won’t run tonight.'
    case 'out-temp':
      return cause.detail.startsWith('Powered')
        ? `Temperature isn’t being delivered: ${cause.detail[0].toLowerCase()}${cause.detail.slice(1)}.`
        : `Bed temperature isn’t updating: ${cause.detail[0].toLowerCase()}${cause.detail.slice(1)}.`
    default:
      return `${cause.label}: ${cause.detail}.`
  }
}

function capitalizeList(items: string[]): string {
  const s = items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
  return s[0].toUpperCase() + s.slice(1)
}

function fixFor(cause: NodeState): Fix | null {
  if (cause.unit) return { kind: 'restart', unit: cause.unit, label: `Restart ${cause.label.toLowerCase()}` }
  if (cause.id === 'scheduler') return { kind: 'link', tab: 'scheduler', label: 'Open scheduler' }
  if (cause.id === 'out-temp') return { kind: 'link', tab: 'thermal', label: 'Open thermal' }
  if (cause.stage === 'sensors' || cause.stage === 'hardware') {
    return {
      kind: 'logs',
      unit: 'sleepypod.service',
      label: 'Open core logs',
      hint: 'The firmware’s own log is on the pod: journalctl -u frank',
    }
  }
  return { kind: 'logs', unit: 'sleepypod.service', label: 'Open core logs' }
}
