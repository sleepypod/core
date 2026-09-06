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
  readdir: vi.fn(async (dir: string): Promise<string[]> => {
    void dir
    return []
  }),
  stat: vi.fn(),
  open: vi.fn(),
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
    promises: { ...actual.promises, readdir: fsMock.readdir, stat: fsMock.stat, open: fsMock.open },
  }
})

vi.mock('ws', () => ({
  WebSocketServer: wsMock.FakeWebSocketServer,
  WebSocket: wsMock.FakeWebSocket,
}))

vi.mock('../capFramePersistence', () => persistenceMock)
vi.mock('../normalizeFrame', () => ({
  capSideChannels: vi.fn(() => null),
  capSideStatus: vi.fn(() => null),
}))
vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getDacMonitorIfRunning: vi.fn(() => null),
}))

type PiezoStreamModule = typeof PiezoStream

const originalWsPort = process.env.PIEZO_WS_PORT
const originalRawDataDir = process.env.RAW_DATA_DIR
const originalNatsDisabled = process.env.PIEZO_NATS_DISABLED
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
  // These contracts pin the legacy `.RAW` tailer; source selection has its
  // own suite (piezoStreamSource.test.ts), and leaving NATS enabled would
  // have startPiezoStreamServer probe a real loopback socket instead of
  // touching the RAW directories.
  process.env.PIEZO_NATS_DISABLED = '1'
  if (options.rawDataDir === null) delete process.env.RAW_DATA_DIR
  else process.env.RAW_DATA_DIR = options.rawDataDir ?? '/unused-test-raw-root'
  loadedModule = await import('../piezoStream')
  return loadedModule
}

const rawEncoder = new Encoder({ useRecords: false })

function rawLogRecord(message: string): Buffer {
  const payload = Buffer.from(rawEncoder.encode({ type: 'log', ts: 100, level: 1, msg: message }))
  const length = Buffer.alloc(3)
  length[0] = 0x59
  length.writeUInt16BE(payload.length, 1)
  return Buffer.concat([
    Buffer.from([0xa2, 0x63, 0x73, 0x65, 0x71, 0x01, 0x64, 0x64, 0x61, 0x74, 0x61]),
    length,
    payload,
  ])
}

function mockRawFile(initial: Buffer) {
  const file = { bytes: initial }
  const handle = {
    stat: vi.fn(async () => ({ size: file.bytes.length })),
    read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => ({
      bytesRead: file.bytes.copy(buffer, offset, position, position + length),
      buffer,
    })),
    close: vi.fn(async () => {}),
  }
  fsMock.readdir.mockResolvedValue(['capture.RAW'])
  fsMock.open.mockResolvedValue(handle)
  return { file, handle }
}

function connectFakeClient() {
  const server = wsMock.state.servers.at(-1)
  if (!server) throw new Error('fake WebSocket server was not created')
  return server.connect()
}

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).__sleepypodSensorStream
  loadedModule = null
  fsMock.readdirSync.mockReset().mockReturnValue([])
  fsMock.readdir.mockReset().mockResolvedValue([])
  fsMock.stat.mockReset().mockResolvedValue({ mtimeMs: 0, isFile: () => true })
  fsMock.open.mockReset()
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
  if (originalNatsDisabled === undefined) delete process.env.PIEZO_NATS_DISABLED
  else process.env.PIEZO_NATS_DISABLED = originalNatsDisabled
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

    await vi.advanceTimersByTimeAsync(25)

    expect(fsMock.readdir.mock.calls.slice(0, 2).map(([dir]) => dir)).toEqual([
      '/persistent',
      path.join('/persistent', 'biometrics'),
    ])
  })

  it('scans RAW directories once per second while polling for appended data', async () => {
    vi.useFakeTimers()
    const piezoStream = await loadFreshModule()
    piezoStream.startPiezoStreamServer()

    await vi.advanceTimersByTimeAsync(25)
    expect(fsMock.readdir).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(975)
    expect(fsMock.readdir).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(25)
    expect(fsMock.readdir).toHaveBeenCalledTimes(4)
    expect(fsMock.readdirSync).not.toHaveBeenCalled()
    expect(fsMock.statSync).not.toHaveBeenCalled()
  })

  it('uses the fallback after skipping SEQNO, directories, and captures removed during an async scan', async () => {
    vi.useFakeTimers()
    mockRawFile(rawLogRecord('fallback'))
    fsMock.readdir.mockImplementation(async dir => dir.endsWith('biometrics')
      ? ['capture.RAW']
      : ['SEQNO.RAW', 'removed.RAW', 'folder.RAW', 'notes.txt'])
    fsMock.stat.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('removed.RAW')) throw new Error('rotated away')
      return { mtimeMs: 0, isFile: () => !filePath.endsWith('folder.RAW') }
    })
    const piezoStream = await loadFreshModule()
    piezoStream.startPiezoStreamServer()
    const client = connectFakeClient()

    await vi.advanceTimersByTimeAsync(25)

    expect(fsMock.open).toHaveBeenCalledWith('/unused-test-raw-root/biometrics/capture.RAW', 'r')
    expect(fsMock.stat.mock.calls.some(([filePath]) => filePath.endsWith('SEQNO.RAW'))).toBe(false)
    expect(client.sent.map(message => JSON.parse(message).msg)).toEqual(['fallback'])
  })

  it('resets the read offset and seek index when an open RAW file is truncated in place', async () => {
    vi.useFakeTimers()
    const { file, handle } = mockRawFile(rawLogRecord('old capture with a longer payload'))
    const piezoStream = await loadFreshModule()
    piezoStream.startPiezoStreamServer()
    const client = connectFakeClient()
    await vi.advanceTimersByTimeAsync(25)

    file.bytes = rawLogRecord('replacement')
    await vi.advanceTimersByTimeAsync(25)

    expect(client.sent.map(message => JSON.parse(message).msg)).toEqual([
      'old capture with a longer payload', 'replacement',
    ])
    expect(piezoStream.__test__.frameIndex).toEqual([{ ts: 100, offset: 0 }])
    expect(fsMock.open).toHaveBeenCalledTimes(1)
    expect(handle.close).not.toHaveBeenCalled()
  })

  it('reaches current RAW data promptly while letting other work run between bounded batches', async () => {
    vi.useFakeTimers()
    // Isolate the record/read bounds from variations in the host CPU speed.
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const messages = Array.from({ length: 600 }, (_, index) => `${index}:${'x'.repeat(200)}`)
    const { file, handle } = mockRawFile(Buffer.concat(messages.map(rawLogRecord)))
    const piezoStream = await loadFreshModule()
    piezoStream.startPiezoStreamServer()
    const client = connectFakeClient()
    let framesWhenOtherWorkRan: number | undefined
    let readsWhenOtherWorkRan: number | undefined
    const send = client.send.bind(client)
    vi.spyOn(client, 'send').mockImplementation((payload: string) => {
      send(payload)
      if (client.sent.length === 1) {
        setTimeout(() => {
          framesWhenOtherWorkRan = client.sent.length
          readsWhenOtherWorkRan = handle.read.mock.calls.length
        }, 0)
      }
    })

    // A backlog must yield for other callbacks without paying the idle poll
    // interval between every batch. The old loop waiting 25ms per batch cannot
    // deliver all 600 frames in this window, even with instantaneous disk reads.
    await vi.advanceTimersByTimeAsync(45)
    expect(framesWhenOtherWorkRan).toBeGreaterThan(0)
    expect(framesWhenOtherWorkRan).toBeLessThanOrEqual(128)
    expect(readsWhenOtherWorkRan).toBe(1)
    expect(client.sent.map(message => JSON.parse(message).msg)).toEqual(messages)
    expect(handle.read.mock.calls.every(([, , length]) => length <= 64 * 1024)).toBe(true)
    expect(fsMock.open).toHaveBeenCalledTimes(1)
    expect(handle.close).not.toHaveBeenCalled()

    file.bytes = Buffer.concat([file.bytes, rawLogRecord('appended')])
    await vi.advanceTimersByTimeAsync(25)
    expect(JSON.parse(client.sent[client.sent.length - 1]).msg).toBe('appended')
    expect(fsMock.open).toHaveBeenCalledTimes(1)
    await piezoStream.shutdownPiezoStreamServer()
    expect(handle.close).toHaveBeenCalledTimes(1)
  })

  it('recovers past a corrupt oversized partial record without waiting for its claimed length', async () => {
    vi.useFakeTimers()
    // A damaged length claims 2 MiB. Once the partial record reaches the 1 MiB
    // limit, discard it and continue with the next valid record.
    const corrupt = Buffer.alloc(1024 * 1024)
    Buffer.from([0xa2, 0x63, 0x73, 0x65, 0x71, 0x01, 0x64, 0x64, 0x61, 0x74, 0x61,
      0x5a, 0x00, 0x20, 0x00, 0x00]).copy(corrupt)
    const { handle } = mockRawFile(Buffer.concat([corrupt, rawLogRecord('recovered')]))
    const piezoStream = await loadFreshModule()
    piezoStream.startPiezoStreamServer()
    const client = connectFakeClient()

    await vi.advanceTimersByTimeAsync(25 * 20)

    expect(client.sent.map(message => JSON.parse(message).msg)).toEqual(['recovered'])
    expect(handle.read.mock.calls.every(([, , length]) => length <= 64 * 1024)).toBe(true)
    expect(fsMock.open).toHaveBeenCalledTimes(1)
  })

  it('waits for an in-flight RAW read on shutdown, closes once, and drops its late frames', async () => {
    vi.useFakeTimers()
    const { handle } = mockRawFile(rawLogRecord('late'))
    const readNormally = handle.read.getMockImplementation()
    if (!readNormally) throw new Error('mock RAW read was not initialized')
    let releaseRead!: () => void
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    handle.read.mockImplementation(async (...args) => {
      await readGate
      return readNormally(...args)
    })
    const piezoStream = await loadFreshModule()
    piezoStream.startPiezoStreamServer()
    const client = connectFakeClient()
    await vi.advanceTimersByTimeAsync(25)
    expect(handle.read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(250)
    expect(handle.read).toHaveBeenCalledTimes(1)

    let stopped = false
    const shutdown = piezoStream.shutdownPiezoStreamServer().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(handle.close).not.toHaveBeenCalled()
    releaseRead()
    await shutdown

    expect(handle.close).toHaveBeenCalledTimes(1)
    expect(client.sent).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(handle.read).toHaveBeenCalledTimes(1)
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
