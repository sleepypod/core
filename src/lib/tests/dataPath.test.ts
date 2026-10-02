import { describe, expect, it } from 'vitest'
import { evaluateDataPath, fmtAgo, type DataPathInputs } from '../dataPath'

const NOW = Date.UTC(2026, 8, 28, 10, 0, 0)
const MIN = 60_000

function healthy(overrides: Partial<DataPathInputs> = {}): DataPathInputs {
  return {
    now: NOW,
    units: {
      'sleepypod-piezo-processor.service': true,
      'sleepypod-sleep-detector.service': true,
      'sleepypod-environment-monitor.service': true,
    },
    frameTimes: { 'piezo-dual': NOW - 1000, 'capSense2': NOW - 1000, 'bedTemp2': NOW - 20_000 },
    sensorSource: 'raw',
    coreUptimeMs: 3_600_000,
    dacSocket: { ok: true, latencyMs: 3 },
    dacMonitor: { status: 'running', lastPollAt: NOW - 2000 },
    database: { ok: true, latencyMs: 0.4 },
    scheduler: { enabled: true, jobs: 12, healthy: true },
    occupied: { left: true, right: false },
    stillness: { left: { rows: 120, maxScore: 120 }, right: { rows: 0, maxScore: 0 } },
    lastVitalAt: { left: NOW - MIN, right: NOW - 20 * 3_600_000 },
    lastMovementAt: { left: NOW - MIN, right: null },
    lastEnvAt: NOW - MIN,
    thermal: [{ side: 'left', verdict: 'holding' }, { side: 'right', verdict: 'off' }],
    streamClients: 1,
    ...overrides,
  }
}

const node = (s: ReturnType<typeof evaluateDataPath>, id: string) => s.nodes.find(n => n.id === id)

describe('evaluateDataPath', () => {
  it('reports everything flowing when every stage has fresh output', () => {
    const s = evaluateDataPath(healthy())
    expect(s.nodes.every(n => n.status === 'ok' || n.status === 'idle')).toBe(true)
    expect(s.verdict.tone).toBe('ok')
    expect(s.verdict.fix).toBeNull()
    expect(s.edges.find(e => e.from === 'database' && e.to === 'out-vitals')?.state).toBe('flowing')
  })

  it('says where each stage lives and how it is doing in its subtitle', () => {
    const s = evaluateDataPath(healthy({ dacSocket: { ok: true, latencyMs: 0.4 }, dacMonitor: { status: 'running', lastPollAt: NOW - 1000, pollIntervalMs: 2000 }, streamClients: 2, streamPort: 3001 }))
    expect(node(s, 'dac')).toMatchObject({ metric: 'dac.sock · 1 ms', path: 'dac.sock' })
    expect(node(s, 'dac-monitor')).toMatchObject({ metric: 'polls 2s · 1s ago', path: 'DacMonitor · polls every 2s' })
    expect(node(s, 'out-live')).toMatchObject({ metric: 'WS :3001 · 2 viewers', path: 'broadcastFrame() → WebSocket :3001 → 2 browsers' })
    expect(node(s, 'piezo-processor')?.path).toBe('sleepypod-piezo-processor.service')
    // Without an interval or port it falls back to what it knows.
    const bare = evaluateDataPath(healthy())
    expect(node(bare, 'dac-monitor')?.metric).toBe('polled 2s ago')
    expect(node(bare, 'out-live')?.metric).toBe('WS · 1 viewer')
  })

  it('flags a running piezo processor that stopped writing while the bed is occupied', () => {
    const s = evaluateDataPath(healthy({ lastVitalAt: { left: NOW - (3 * 60 + 56) * MIN, right: null } }))
    expect(node(s, 'piezo-processor')?.status).toBe('stale')
    expect(node(s, 'out-vitals')?.status).toBe('stale')
    // Upstream is fine — the break is at the processor, not the sensors.
    expect(node(s, 'sensor-piezo')?.status).toBe('ok')
    expect(node(s, 'frames')?.status).toBe('ok')
    expect(s.verdict.nodeId).toBe('piezo-processor')
    expect(s.verdict.lastGoodId).toBe('frames')
    expect(s.verdict.headline).toContain('Vitals stopped 3h 56m ago')
    expect(s.verdict.fix).toEqual({ kind: 'restart', unit: 'sleepypod-piezo-processor.service', label: 'Restart piezo processor' })
    expect(s.edges.find(e => e.from === 'piezo-processor')?.state).toBe('stalled')
    expect(s.edges.find(e => e.from === 'frames' && e.to === 'piezo-processor')?.state).toBe('flowing')
  })

  it('treats old vitals as idle, not stale, when nobody is in bed', () => {
    const s = evaluateDataPath(healthy({ occupied: { left: false, right: false }, lastVitalAt: { left: NOW - 10 * 3_600_000, right: null } }))
    expect(node(s, 'piezo-processor')?.status).toBe('idle')
    expect(node(s, 'out-vitals')?.status).toBe('idle')
    expect(s.verdict.tone).toBe('ok')
    expect(s.verdict.headline).toContain('idle until someone gets in bed')
  })

  it('judges the side in bed, not the freshest side', () => {
    const s = evaluateDataPath(healthy({
      occupied: { left: false, right: true },
      lastVitalAt: { left: NOW - MIN, right: NOW - 2 * 3_600_000 },
    }))
    expect(node(s, 'piezo-processor')?.status).toBe('stale')
  })

  it('reports a stopped module as down with a restart fix', () => {
    const s = evaluateDataPath(healthy({
      units: {
        'sleepypod-piezo-processor.service': true,
        'sleepypod-sleep-detector.service': false,
        'sleepypod-environment-monitor.service': true,
      },
    }))
    expect(node(s, 'sleep-detector')?.status).toBe('down')
    expect(s.verdict.nodeId).toBe('sleep-detector')
    expect(s.verdict.headline).toContain('isn’t running')
  })

  it('blames the sensors, not every downstream stage, when frames stop', () => {
    const s = evaluateDataPath(healthy({ frameTimes: { 'piezo-dual': NOW - 10 * MIN, 'capSense2': NOW - 1000, 'bedTemp2': NOW - 1000 }, lastVitalAt: { left: NOW - 20 * MIN, right: null } }))
    expect(node(s, 'sensor-piezo')?.status).toBe('stale')
    expect(node(s, 'piezo-processor')?.status).toBe('stale')
    expect(s.verdict.nodeId).toBe('sensor-piezo')
    expect(s.verdict.tone).toBe('danger')
    expect(s.verdict.fix?.kind).toBe('logs')
  })

  it('reports unknown rather than broken on a dev box with no systemd and no data', () => {
    const s = evaluateDataPath(healthy({
      units: {
        'sleepypod-piezo-processor.service': null,
        'sleepypod-sleep-detector.service': null,
        'sleepypod-environment-monitor.service': null,
      },
      lastVitalAt: { left: null, right: null },
      lastMovementAt: { left: null, right: null },
      lastEnvAt: null,
    }))
    expect(node(s, 'piezo-processor')?.status).toBe('unknown')
    expect(node(s, 'environment-monitor')?.status).toBe('unknown')
  })

  it('names only the outputs a break reaches and lists independent breaks separately', () => {
    const s = evaluateDataPath(healthy({
      frameTimes: { 'piezo-dual': NOW - 10 * MIN, 'capSense2': NOW - 1000, 'bedTemp2': NOW - 1000 },
      lastVitalAt: { left: NOW - 20 * MIN, right: null },
      dacSocket: { ok: false, latencyMs: 0, error: 'EACCES' },
      dacMonitor: { status: 'degraded', lastPollAt: NOW - 10 * MIN },
    }))
    expect(s.verdict.nodeId).toBe('sensor-piezo')
    expect(s.verdict.headline).toContain('Vitals can’t update')
    expect(s.verdict.headline).not.toContain('bed temperature')
    expect(s.verdict.also).toEqual(['DAC socket down'])
  })

  it('asks whether anyone is there when a side reads occupied with no vitals or restless movement', () => {
    const s = evaluateDataPath(healthy({
      // Small scores are restart noise, not a body turning over.
      stillness: { left: { rows: 119, maxScore: 2 }, right: { rows: 0, maxScore: 0 } },
      lastVitalAt: { left: NOW - (7 * 60 + 56) * MIN, right: null },
    }))
    expect(s.occupancy).toEqual({ left: 'suspect', right: 'empty' })
    // Neither blamed nor cleared until someone answers.
    expect(node(s, 'piezo-processor')?.status).toBe('unknown')
    expect(node(s, 'sleep-detector')?.status).toBe('stale')
    expect(s.verdict.nodeId).toBe('sleep-detector')
    expect(s.verdict.headline).toBe('Left side reads occupied, but no vitals or movement for 7h 56m. Is anyone there?')
    expect(s.verdict.fix).toEqual({ kind: 'occupancy', sides: ['left'], unit: 'sleepypod-piezo-processor.service', label: 'Is anyone there?' })
  })

  it('keeps a restless side with no vitals as occupied, so the piezo processor is blamed', () => {
    const s = evaluateDataPath(healthy({
      stillness: { left: { rows: 120, maxScore: 180 }, right: { rows: 0, maxScore: 0 } },
      lastVitalAt: { left: NOW - 3 * 60 * MIN, right: null },
    }))
    expect(s.occupancy.left).toBe('occupied')
    expect(s.verdict.nodeId).toBe('piezo-processor')
  })

  it('doesn’t judge a session that only just started', () => {
    const s = evaluateDataPath(healthy({
      stillness: { left: { rows: 20, maxScore: 0 }, right: { rows: 0, maxScore: 0 } },
      lastVitalAt: { left: null, right: null },
    }))
    expect(s.occupancy.left).toBe('occupied')
  })

  it('keeps a still sleeper with vitals as occupied', () => {
    const s = evaluateDataPath(healthy({ stillness: { left: { rows: 120, maxScore: 0 }, right: { rows: 0, maxScore: 0 } } }))
    expect(s.occupancy.left).toBe('occupied')
    expect(s.verdict.tone).toBe('ok')
  })

  it('waits out the startup grace before calling silent sensors stalled', () => {
    const silent = { frameTimes: {}, lastVitalAt: { left: null, right: null } }
    const early = evaluateDataPath(healthy({ ...silent, coreUptimeMs: 30_000 }))
    expect(early.nodes.find(n => n.id === 'sensor-piezo')?.status).toBe('unknown')
    const later = evaluateDataPath(healthy({ ...silent, coreUptimeMs: 10 * MIN }))
    expect(later.nodes.find(n => n.id === 'sensor-piezo')?.status).toBe('stale')
    expect(later.verdict.nodeId).toBe('sensor-piezo')
  })

  it('gives a just-started DAC monitor until its first poll', () => {
    const fresh = evaluateDataPath(healthy({ coreUptimeMs: 20_000, dacMonitor: { status: 'running', lastPollAt: null } }))
    expect(fresh.nodes.find(n => n.id === 'dac-monitor')?.status).toBe('unknown')
    expect(fresh.verdict.also).toEqual([])
    // Nothing downstream is called stalled while it waits either.
    expect(fresh.nodes.find(n => n.id === 'out-temp')?.status).toBe('unknown')
    expect(fresh.verdict.tone).toBe('ok')
    const later = evaluateDataPath(healthy({ coreUptimeMs: 10 * MIN, dacMonitor: { status: 'running', lastPollAt: null } }))
    expect(later.nodes.find(n => n.id === 'dac-monitor')?.status).toBe('stale')
  })

  it('marks bed temperature stale when a powered side’s pump is stalled', () => {
    const s = evaluateDataPath(healthy({ thermal: [{ side: 'left', verdict: 'stalled' }, { side: 'right', verdict: 'off' }] }))
    expect(node(s, 'out-temp')?.status).toBe('stale')
    expect(s.verdict.nodeId).toBe('out-temp')
    expect(s.verdict.fix).toEqual({ kind: 'link', tab: 'thermal', label: 'Open thermal' })
  })

  it('flags an enabled scheduler with no jobs', () => {
    const s = evaluateDataPath(healthy({ scheduler: { enabled: true, jobs: 0, healthy: false } }))
    expect(node(s, 'scheduler')?.status).toBe('stale')
    expect(s.verdict.fix).toEqual({ kind: 'link', tab: 'scheduler', label: 'Open scheduler' })
  })
})

describe('fmtAgo', () => {
  it.each([
    [5_000, '5s ago'],
    [14 * MIN, '14m ago'],
    [(3 * 60 + 56) * MIN, '3h 56m ago'],
    [72 * 3_600_000, '3d ago'],
  ])('%i ms → %s', (ms, out) => {
    expect(fmtAgo(ms)).toBe(out)
  })
})
