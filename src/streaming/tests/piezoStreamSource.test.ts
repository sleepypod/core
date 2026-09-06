// @vitest-environment node
/**
 * Source-selection tests for startPiezoStreamServer: the reachability probe
 * picks NATS when a server is present and falls back to the `.RAW` file tailer
 * otherwise, and the chosen source feeds the same shared dispatch (proven via
 * the in-process capSense snapshot). `../natsFrameSource` is mocked so the probe
 * result is controllable without a real NATS server.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports */

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Encoder } from 'cbor-x'

const tmpRawDir = vi.hoisted(() => {
  const fsh = require('node:fs') as typeof import('node:fs')
  const osh = require('node:os') as typeof import('node:os')
  const pth = require('node:path') as typeof import('node:path')
  const dir = fsh.mkdtempSync(pth.join(osh.tmpdir(), 'piezo-nats-sel-'))
  process.env.RAW_DATA_DIR = dir
  process.env.PIEZO_WS_PORT = '0'
  // Short grace/probe so the RAW-fallback path resolves in well under a second.
  process.env.PIEZO_NATS_GRACE_MS = '120'
  process.env.PIEZO_NATS_PROBE_INTERVAL_MS = '15'
  delete process.env.PIEZO_NATS_DISABLED
  delete process.env.PIEZO_SENSOR_SOURCE
  return dir
})

// Controllable stand-in for the NATS source. `reachable` flips per test; the
// captured options let us drive the real dispatch via onFrame.
const natsMock = vi.hoisted(() => ({
  reachable: false,
  probeErrorOnce: false,
  startError: null as Error | null,
  startPromise: null as Promise<void> | null,
  resolveStart: null as (() => void) | null,
  startCalls: 0,
  stopCalls: 0,
  captured: null as any,
  stop: async () => { natsMock.stopCalls += 1 },
}))

vi.mock('../natsFrameSource', () => ({
  SUBSCRIBE_SUBJECTS: ['raw.sens.>', 'raw.frz.>'],
  natsReachable: vi.fn(async () => {
    if (natsMock.probeErrorOnce) {
      natsMock.probeErrorOnce = false
      throw new Error('probe failed')
    }
    return natsMock.reachable
  }),
  startNatsFrameSource: vi.fn(async (opts: any) => {
    natsMock.startCalls += 1
    natsMock.captured = opts
    if (natsMock.startError) throw natsMock.startError
    if (natsMock.startPromise) await natsMock.startPromise
    opts.onReady?.()
    return { stop: natsMock.stop, stats: { messages: 0, framesDecoded: 0, decodeFailures: 0 } }
  }),
}))

vi.mock('../sensorSourceDiscovery', () => ({
  discoverSensorSource: vi.fn(async () => 'unknown'),
}))

// Keep persistence hermetic — dispatch → recordCapFrame must not touch a real db.
vi.mock('@/src/db', () => {
  const chain = { values: () => chain, onConflictDoNothing: () => chain, where: () => chain, run: () => {} }
  return { biometricsDb: { insert: () => chain, delete: () => chain } }
})

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getDacMonitorIfRunning: vi.fn(() => null),
}))

import {
  __test__,
  getLatestCapSenseSnapshot,
  shutdownPiezoStreamServer,
  startPiezoStreamServer,
} from '../piezoStream'
import { natsReachable, startNatsFrameSource } from '../natsFrameSource'
import { discoverSensorSource } from '../sensorSourceDiscovery'

const innerEncoder = new Encoder({ mapsAsObjects: true, useRecords: false })

function encodeByteString(payload: Buffer): Buffer {
  const len = payload.length
  if (len < 0x100) return Buffer.concat([Buffer.from([0x58, len]), payload])
  const head = Buffer.alloc(3)
  head[0] = 0x59
  head.writeUInt16BE(len, 1)
  return Buffer.concat([head, payload])
}

/** Minimal `{seq, data}` outer RAW record wrapping one CBOR inner frame. */
function buildOuterRecord(seq: number, frame: Record<string, unknown>): Buffer {
  const inner = Buffer.from(innerEncoder.encode(frame))
  return Buffer.concat([
    Buffer.from([0xa2]), // map(2)
    Buffer.from([0x63, 0x73, 0x65, 0x71]), // "seq"
    Buffer.from([seq]), // small unsigned seq (0–23 inline)
    Buffer.from([0x64, 0x64, 0x61, 0x74, 0x61]), // "data"
    encodeByteString(inner),
  ])
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('startPiezoStreamServer — source selection', () => {
  afterEach(async () => {
    await shutdownPiezoStreamServer()
    vi.useRealTimers()
    natsMock.reachable = false
    natsMock.probeErrorOnce = false
    natsMock.startError = null
    natsMock.startPromise = null
    natsMock.resolveStart = null
    natsMock.startCalls = 0
    natsMock.stopCalls = 0
    natsMock.captured = null
    for (const f of fs.readdirSync(tmpRawDir)) fs.rmSync(path.join(tmpRawDir, f), { force: true })
    delete process.env.PIEZO_SENSOR_SOURCE
    vi.mocked(discoverSensorSource).mockResolvedValue('unknown')
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('discards a probe from a server that was shut down and restarted', async () => {
    let resolveProbe!: (value: boolean) => void
    vi.mocked(natsReachable).mockImplementationOnce(() => new Promise((resolve) => {
      resolveProbe = resolve
    }))
    startPiezoStreamServer()
    await waitFor(() => vi.mocked(natsReachable).mock.calls.length === 1)
    await shutdownPiezoStreamServer()
    natsMock.reachable = true
    startPiezoStreamServer()
    await waitFor(() => __test__.natsSourceActive)
    resolveProbe(true)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(startNatsFrameSource).toHaveBeenCalledTimes(1)
  })

  it('stops a stale connection and ignores its frames after restart', async () => {
    natsMock.reachable = true
    let resolveStart!: () => void
    natsMock.startPromise = new Promise((resolve) => {
      resolveStart = resolve
    })
    startPiezoStreamServer()
    await waitFor(() => natsMock.startCalls === 1)
    const staleOptions = natsMock.captured
    await shutdownPiezoStreamServer()
    natsMock.startPromise = null
    startPiezoStreamServer()
    await waitFor(() => __test__.natsSourceActive)
    const before = getLatestCapSenseSnapshot()
    staleOptions.onFrame({ type: 'capSense', ts: Date.now() / 1000, left: 999, right: 999 })
    expect(getLatestCapSenseSnapshot()).toBe(before)
    resolveStart()
    await waitFor(() => natsMock.stopCalls === 1)
    expect(__test__.natsSourceActive).toBe(true)
    expect(natsMock.startCalls).toBe(2)
  })

  it('shares the source and snapshot across duplicate module loads', async () => {
    natsMock.reachable = true
    const server = startPiezoStreamServer()
    await waitFor(() => __test__.natsSourceActive)
    vi.resetModules()
    const duplicate = await import('../piezoStream')
    expect(duplicate.startPiezoStreamServer()).toBe(server)
    expect(startNatsFrameSource).toHaveBeenCalledTimes(1)
    expect(duplicate.getLatestCapSenseSnapshot()).toBe(getLatestCapSenseSnapshot())
  })

  it.each(['NaN', 'Infinity', '-1'])('defaults invalid NATS timing %s', (value) => {
    expect(__test__.natsTiming(value, 60000, true)).toBe(60000)
    expect(__test__.natsTiming(value, 5000, false)).toBe(5000)
  })
  it('allows zero grace but requires a positive probe interval', () => {
    expect(__test__.natsTiming('0', 60000, true)).toBe(0)
    expect(__test__.natsTiming('0', 5000, false)).toBe(5000)
    expect(__test__.natsTiming('12', 5000, false)).toBe(12)
  })

  it('selects NATS when reachable and routes its frames into the shared dispatch', async () => {
    natsMock.reachable = true
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    startPiezoStreamServer()

    await waitFor(() => __test__.natsSourceActive)
    expect(startNatsFrameSource).toHaveBeenCalledTimes(1)

    // The mocked source received the real decode + dispatch wiring; feeding a
    // capSense frame through onFrame must land in the live snapshot.
    const now = Math.floor(Date.now() / 1000)
    natsMock.captured.onFrame({
      type: 'capSense',
      ts: now,
      left: { out: 100, cen: 200, in: 300, status: 'good' },
      right: { out: 110, cen: 210, in: 310, status: 'good' },
    })
    const snap = getLatestCapSenseSnapshot()
    expect(snap?.type).toBe('capSense')
    expect(snap?.left).toEqual([100, 100, 200, 200, 300, 300])

    const closeError = new Error('closed')
    natsMock.captured.onClose(closeError)
    expect(error).toHaveBeenCalledWith('[sensorStream] NATS frame source closed', closeError)
    error.mockRestore()
  })

  it('falls back to .RAW tailing when NATS is unreachable', async () => {
    natsMock.reachable = false
    startPiezoStreamServer()

    const now = Math.floor(Date.now() / 1000)
    fs.writeFileSync(
      path.join(tmpRawDir, 'sel.RAW'),
      buildOuterRecord(1, {
        type: 'capSense',
        ts: now,
        left: { out: 5, cen: 6, in: 7 },
        right: { out: 8, cen: 9, in: 10 },
      }),
    )

    // The RAW loop starts only after the grace window; wait for its snapshot.
    await waitFor(() => {
      const l = getLatestCapSenseSnapshot()?.left
      return Array.isArray(l) && l[0] === 5
    })
    expect(__test__.natsSourceActive).toBe(false)
    expect(startNatsFrameSource).not.toHaveBeenCalled()
    // The probe was attempted (reachability drives selection).
    expect(natsReachable).toHaveBeenCalled()
  })

  it('continues probing after a reachability probe throws, then selects RAW', async () => {
    natsMock.probeErrorOnce = true
    natsMock.reachable = false
    startPiezoStreamServer()

    const now = Math.floor(Date.now() / 1000)
    fs.writeFileSync(
      path.join(tmpRawDir, 'probe-error.RAW'),
      buildOuterRecord(2, {
        type: 'capSense',
        ts: now,
        left: { out: 15, cen: 16, in: 17 },
        right: { out: 18, cen: 19, in: 20 },
      }),
    )

    await waitFor(() => {
      const left = getLatestCapSenseSnapshot()?.left
      return Array.isArray(left) && left[0] === 15
    })
    expect(vi.mocked(natsReachable).mock.calls.length).toBeGreaterThan(1)
    expect(startNatsFrameSource).not.toHaveBeenCalled()
  })

  it('retries failed NATS connections through the grace window before selecting RAW on unknown firmware', async () => {
    natsMock.reachable = true
    natsMock.startError = new Error('connect raced')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    startPiezoStreamServer()

    const now = Math.floor(Date.now() / 1000)
    fs.writeFileSync(
      path.join(tmpRawDir, 'connect-error.RAW'),
      buildOuterRecord(3, {
        type: 'capSense',
        ts: now,
        left: { out: 25, cen: 26, in: 27 },
        right: { out: 28, cen: 29, in: 30 },
      }),
    )

    await waitFor(() => {
      const left = getLatestCapSenseSnapshot()?.left
      return Array.isArray(left) && left[0] === 25
    })
    expect(vi.mocked(startNatsFrameSource).mock.calls.length).toBeGreaterThan(1)
    expect(error).toHaveBeenCalledWith(
      '[sensorStream] NATS connect failed; retrying source discovery:',
      natsMock.startError,
    )
    error.mockRestore()
  })

  it('skips the grace window on confirmed RAW firmware after one failed greeting probe', async () => {
    vi.mocked(discoverSensorSource).mockResolvedValue('raw')
    fs.writeFileSync(path.join(tmpRawDir, 'confirmed-raw.RAW'), buildOuterRecord(1, {
      type: 'capSense', ts: 123, left: 35, right: 36,
    }))
    startPiezoStreamServer()

    await waitFor(() => getLatestCapSenseSnapshot()?.ts === 123)
    expect(natsReachable).toHaveBeenCalledTimes(1)
    expect(startNatsFrameSource).not.toHaveBeenCalled()
  })

  it('recovers from unknown installation discovery on the next retry and starts RAW before grace expires', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.mocked(discoverSensorSource).mockResolvedValueOnce('unknown').mockResolvedValue('raw')
    const readdir = vi.spyOn(fs.promises, 'readdir').mockResolvedValue([])
    const startedAt = Date.now()
    startPiezoStreamServer()

    await vi.advanceTimersByTimeAsync(0)
    expect(discoverSensorSource).toHaveBeenCalledTimes(1)
    expect(natsReachable).toHaveBeenCalledTimes(1)
    expect(readdir).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(14)
    expect(discoverSensorSource).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(discoverSensorSource).toHaveBeenCalledTimes(2)
    expect(natsReachable).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(25)
    expect(readdir).toHaveBeenCalledWith(tmpRawDir)
    expect(Date.now() - startedAt).toBe(40)
    // RAW is already polling after one retry and one poll tick, well before
    // this suite's 120 ms grace (60 seconds in production).
    expect(startNatsFrameSource).not.toHaveBeenCalled()

    // Once RAW owns ingestion, later installation changes must not attach a
    // second source or restart discovery.
    vi.mocked(discoverSensorSource).mockResolvedValue('nats')
    natsMock.reachable = true
    await vi.advanceTimersByTimeAsync(1000)
    expect(discoverSensorSource).toHaveBeenCalledTimes(2)
    expect(natsReachable).toHaveBeenCalledTimes(2)
    expect(startNatsFrameSource).not.toHaveBeenCalled()
  })

  it('prefers a live NATS greeting even when installation discovery says RAW', async () => {
    vi.mocked(discoverSensorSource).mockResolvedValue('raw')
    natsMock.reachable = true
    startPiezoStreamServer()

    await waitFor(() => __test__.natsSourceActive)
    expect(natsReachable).toHaveBeenCalledTimes(1)
    expect(startNatsFrameSource).toHaveBeenCalledTimes(1)
  })

  it.each(['discovery', 'override'] as const)('waits beyond grace for known NATS via %s without reading RAW', async (selection) => {
    if (selection === 'override') process.env.PIEZO_SENSOR_SOURCE = 'nats'
    else vi.mocked(discoverSensorSource).mockResolvedValue('nats')
    fs.writeFileSync(path.join(tmpRawDir, 'must-not-read.RAW'), buildOuterRecord(1, {
      type: 'capSense', ts: 456, left: 99, right: 99,
    }))
    const before = getLatestCapSenseSnapshot()
    const readdir = vi.spyOn(fs.promises, 'readdir')
    startPiezoStreamServer()
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(vi.mocked(natsReachable).mock.calls.length).toBeGreaterThan(1)
    expect(readdir).not.toHaveBeenCalled()
    expect(getLatestCapSenseSnapshot()).toBe(before)
    if (selection === 'override') expect(discoverSensorSource).not.toHaveBeenCalled()
    natsMock.reachable = true
    await waitFor(() => __test__.natsSourceActive)
    expect(startNatsFrameSource).toHaveBeenCalledTimes(1)
    expect(readdir).not.toHaveBeenCalled()
  })

  it('retries a connection race on known NATS firmware without selecting RAW', async () => {
    vi.mocked(discoverSensorSource).mockResolvedValue('nats')
    natsMock.reachable = true
    natsMock.startError = new Error('connect raced')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const readdir = vi.spyOn(fs.promises, 'readdir')
    startPiezoStreamServer()
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(natsMock.startCalls).toBeGreaterThan(1)
    expect(readdir).not.toHaveBeenCalled()
    natsMock.startError = null
    await waitFor(() => __test__.natsSourceActive)
    expect(readdir).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('honors an explicit RAW override without discovery or a NATS greeting', async () => {
    process.env.PIEZO_SENSOR_SOURCE = 'raw'
    natsMock.reachable = true
    fs.writeFileSync(path.join(tmpRawDir, 'override-raw.RAW'), buildOuterRecord(1, {
      type: 'capSense', ts: 789, left: 10, right: 11,
    }))
    startPiezoStreamServer()

    await waitFor(() => getLatestCapSenseSnapshot()?.ts === 789)
    expect(discoverSensorSource).not.toHaveBeenCalled()
    expect(natsReachable).not.toHaveBeenCalled()
    expect(startNatsFrameSource).not.toHaveBeenCalled()
  })

  it('stops source selection when shutdown happens during the retry delay', async () => {
    natsMock.reachable = false
    startPiezoStreamServer()
    await waitFor(() => vi.mocked(natsReachable).mock.calls.length > 0)

    await shutdownPiezoStreamServer()
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(startNatsFrameSource).not.toHaveBeenCalled()
    expect(__test__.natsSourceActive).toBe(false)
  })

  it('stops a NATS source whose first connection completes after shutdown', async () => {
    natsMock.reachable = true
    natsMock.startPromise = new Promise<void>((resolve) => {
      natsMock.resolveStart = resolve
    })
    startPiezoStreamServer()
    await waitFor(() => natsMock.startCalls === 1)

    await shutdownPiezoStreamServer()
    natsMock.resolveStart?.()
    await waitFor(() => natsMock.stopCalls === 1)

    expect(__test__.natsSourceActive).toBe(false)
  })
})
