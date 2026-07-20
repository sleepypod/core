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
  return dir
})

// Controllable stand-in for the NATS source. `reachable` flips per test; the
// captured options let us drive the real dispatch via onFrame.
const natsMock = vi.hoisted(() => ({
  reachable: false,
  probeErrorOnce: false,
  probePromise: null as Promise<boolean> | null,
  resolveProbe: null as ((reachable: boolean) => void) | null,
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
    if (natsMock.probePromise) return natsMock.probePromise
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
    natsMock.reachable = false
    natsMock.probeErrorOnce = false
    natsMock.probePromise = null
    natsMock.resolveProbe = null
    natsMock.startError = null
    natsMock.startPromise = null
    natsMock.resolveStart = null
    natsMock.startCalls = 0
    natsMock.stopCalls = 0
    natsMock.captured = null
    for (const f of fs.readdirSync(tmpRawDir)) fs.rmSync(path.join(tmpRawDir, f), { force: true })
    vi.clearAllMocks()
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

  it('falls back to RAW when NATS connect fails after a positive probe', async () => {
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
    expect(startNatsFrameSource).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(
      '[sensorStream] NATS connect failed, falling back to .RAW tailing:',
      natsMock.startError,
    )
    error.mockRestore()
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

  it('does not attach a stale NATS source after shutdown and restart', async () => {
    natsMock.reachable = true
    natsMock.startPromise = new Promise<void>((resolve) => {
      natsMock.resolveStart = resolve
    })
    startPiezoStreamServer()
    await waitFor(() => natsMock.startCalls === 1)

    await shutdownPiezoStreamServer()
    natsMock.reachable = false
    startPiezoStreamServer()

    natsMock.resolveStart?.()
    await waitFor(() => natsMock.stopCalls === 1)

    expect(__test__.natsSourceActive).toBe(false)
    expect(natsMock.startCalls).toBe(1)
  })

  it('does not continue a stale reachability probe after restart', async () => {
    natsMock.probePromise = new Promise<boolean>((resolve) => {
      natsMock.resolveProbe = resolve
    })
    startPiezoStreamServer()
    await waitFor(() => vi.mocked(natsReachable).mock.calls.length === 1)

    await shutdownPiezoStreamServer()
    startPiezoStreamServer()
    await waitFor(() => vi.mocked(natsReachable).mock.calls.length === 2)

    natsMock.resolveProbe?.(true)
    await waitFor(() => __test__.natsSourceActive)

    expect(startNatsFrameSource).toHaveBeenCalledTimes(1)
  })

  it('falls back to safe defaults for invalid source-selection timings', () => {
    process.env.TEST_NATS_TIMING = 'not-a-number'
    expect(__test__.envMilliseconds('TEST_NATS_TIMING', 123, 0)).toBe(123)
    process.env.TEST_NATS_TIMING = ''
    expect(__test__.envMilliseconds('TEST_NATS_TIMING', 123, 0)).toBe(123)
    process.env.TEST_NATS_TIMING = '-1'
    expect(__test__.envMilliseconds('TEST_NATS_TIMING', 123, 0)).toBe(123)
    process.env.TEST_NATS_TIMING = '0'
    expect(__test__.envMilliseconds('TEST_NATS_TIMING', 123, 1)).toBe(123)
    expect(__test__.envMilliseconds('TEST_NATS_TIMING', 123, 0)).toBe(0)
    delete process.env.TEST_NATS_TIMING
  })
})
