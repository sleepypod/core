// @vitest-environment node

import path from 'node:path'
import { Encoder } from 'cbor-x'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type * as PiezoStream from '../piezoStream'

const fsMock = vi.hoisted(() => ({
  readdirSync: vi.fn((dir: string): string[] => {
    void dir
    return []
  }),
  statSync: vi.fn(() => ({ mtimeMs: 0 })),
}))

const wsMock = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void

  class FakeClient {
    readonly bufferedAmount = 0
    readonly sent: string[] = []
    readyState = 1
    private readonly handlers = new Map<string, Handler[]>()

    on(eventName: string, listener: Handler): this {
      const listeners = this.handlers.get(eventName) ?? []
      listeners.push(listener)
      this.handlers.set(eventName, listeners)
      return this
    }

    send(payload: string): void {
      this.sent.push(payload)
    }

    emitMessage(payload: string): void {
      for (const listener of this.handlers.get('message') ?? []) {
        listener(Buffer.from(payload))
      }
    }

    terminate(): void {
      this.readyState = 3
      for (const listener of this.handlers.get('close') ?? []) listener()
    }
  }

  const state = {
    connectionHandler: null as ((client: FakeClient) => void) | null,
    options: [] as Array<Record<string, unknown>>,
    servers: [] as FakeWebSocketServer[],
  }

  class FakeWebSocketServer {
    readonly clients = new Set<FakeClient>()

    constructor(options: Record<string, unknown>) {
      state.options.push(options)
      state.servers.push(this)
    }

    on(eventName: string, listener: Handler): this {
      if (eventName === 'connection') {
        state.connectionHandler = listener as (client: FakeClient) => void
      }
      return this
    }

    connect(client = new FakeClient()): FakeClient {
      this.clients.add(client)
      state.connectionHandler?.(client)
      return client
    }

    close(callback?: () => void): void {
      callback?.()
    }
  }

  const FakeWebSocket = { OPEN: 1, CLOSED: 3 }

  return { state, FakeWebSocketServer, FakeWebSocket }
})

const persistenceMock = vi.hoisted(() => ({
  flushCapFrameWindows: vi.fn(),
  recordCapFrame: vi.fn(),
  resetCapFrameWindows: vi.fn(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    readdirSync: fsMock.readdirSync,
    statSync: fsMock.statSync,
  }
})

vi.mock('ws', () => ({
  WebSocketServer: wsMock.FakeWebSocketServer,
  WebSocket: wsMock.FakeWebSocket,
}))

vi.mock('../capFramePersistence', () => persistenceMock)
vi.mock('../normalizeFrame', () => ({ capSideChannels: vi.fn(() => null) }))
vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getDacMonitorIfRunning: vi.fn(() => null),
}))

type PiezoStreamModule = typeof PiezoStream

const originalWsPort = process.env.PIEZO_WS_PORT
const originalRawDataDir = process.env.RAW_DATA_DIR
let loadedModule: PiezoStreamModule | null = null

function restoreEnv(name: 'PIEZO_WS_PORT' | 'RAW_DATA_DIR', value: string | undefined): void {
  if (name === 'PIEZO_WS_PORT') {
    if (value === undefined) delete process.env.PIEZO_WS_PORT
    else process.env.PIEZO_WS_PORT = value
  }
  else if (value === undefined) delete process.env.RAW_DATA_DIR
  else process.env.RAW_DATA_DIR = value
}

async function loadFreshModule(options: {
  wsPort?: string
  rawDataDir?: string | null
} = {}): Promise<PiezoStreamModule> {
  vi.resetModules()
  process.env.PIEZO_WS_PORT = options.wsPort ?? '0'
  if (options.rawDataDir === null) delete process.env.RAW_DATA_DIR
  else process.env.RAW_DATA_DIR = options.rawDataDir ?? '/unused-test-raw-root'
  loadedModule = await import('../piezoStream')
  return loadedModule
}

beforeEach(() => {
  loadedModule = null
  fsMock.readdirSync.mockReset().mockReturnValue([])
  fsMock.statSync.mockReset().mockReturnValue({ mtimeMs: 0 })
  wsMock.state.connectionHandler = null
  wsMock.state.options.length = 0
  wsMock.state.servers.length = 0
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  if (loadedModule) await loadedModule.shutdownPiezoStreamServer()
  vi.useRealTimers()
  restoreEnv('PIEZO_WS_PORT', originalWsPort)
  restoreEnv('RAW_DATA_DIR', originalRawDataDir)
  vi.restoreAllMocks()
})

describe('piezoStream module initialization contracts', () => {
  it('passes the configured WebSocket port to the server constructor', async () => {
    const piezoStream = await loadFreshModule({ wsPort: '4311' })

    piezoStream.startPiezoStreamServer()

    expect(wsMock.state.options).toContainEqual(expect.objectContaining({
      port: 4311,
      maxPayload: 1024,
    }))
  })

  it('probes the persistent root and biometrics fallback after a fresh import', async () => {
    vi.useFakeTimers()
    const piezoStream = await loadFreshModule({ rawDataDir: null })
    piezoStream.startPiezoStreamServer()

    vi.advanceTimersByTime(10)

    expect(fsMock.readdirSync.mock.calls.slice(0, 2).map(([dir]) => dir)).toEqual([
      '/persistent',
      path.join('/persistent', 'biometrics'),
    ])
  })

  it('preserves the configured frame-index window and backpressure budget', async () => {
    const piezoStream = await loadFreshModule()

    expect(piezoStream.__test__.FRAME_INDEX_RETENTION_S).toBe(40)
    expect(piezoStream.__test__.MAX_BUFFERED_BYTES).toBe(1024 * 1024)
  })

  it('decodes plain CBOR maps as sensor-frame objects', async () => {
    const piezoStream = await loadFreshModule()
    const frame = { type: 'log', ts: 1, level: 2, msg: 'ready' }
    const encoded = Buffer.from(new Encoder({ useRecords: false }).encode(frame))

    expect(piezoStream.__test__.decodeSensorFrames(encoded)).toEqual([frame])
  })

  it('rejects a seek before any RAW file is indexed and still completes it', async () => {
    const piezoStream = await loadFreshModule()
    piezoStream.startPiezoStreamServer()
    const server = wsMock.state.servers.at(-1)
    if (!server) throw new Error('fake WebSocket server was not created')
    const client = server.connect()

    client.emitMessage(JSON.stringify({ type: 'seek', timestamp: 1 }))

    await vi.waitFor(() => expect(client.sent).toHaveLength(2))
    expect(client.sent.map(message => JSON.parse(message))).toEqual([
      { type: 'error', message: 'No RAW file indexed yet' },
      { type: 'seek_complete' },
    ])
  })
})
