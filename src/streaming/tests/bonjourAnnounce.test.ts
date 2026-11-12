import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  execFileSync: vi.fn(),
  advertise: vi.fn(),
  destroy: vi.fn(),
  shutdown: vi.fn(),
  createService: vi.fn(),
  getResponder: vi.fn(),
}))

vi.mock('node:fs', () => {
  const api = {
    existsSync: mocks.existsSync,
    readFileSync: mocks.readFileSync,
    mkdirSync: mocks.mkdirSync,
    writeFileSync: mocks.writeFileSync,
    unlinkSync: mocks.unlinkSync,
  }
  return { ...api, default: api }
})
vi.mock('node:child_process', () => {
  const api = { execFileSync: mocks.execFileSync }
  return { ...api, default: api }
})
vi.mock('node:os', () => {
  const api = { hostname: () => 'eight-pod' }
  return { ...api, default: api }
})
vi.mock('../mdnsResponder', () => ({ loadDiscoveryResponder: () => ({ getResponder: mocks.getResponder }) }))

const SERVICE_FILE = '/etc/avahi/services/sleepypod.service'
const STATE_KEY = '__sleepypod_bonjour_lifecycle__'
let signal: ReturnType<typeof vi.spyOn>
let logs: ReturnType<typeof vi.spyOn>
let warnings: ReturnType<typeof vi.spyOn>

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  Reflect.deleteProperty(globalThis, STATE_KEY)
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('PORT', undefined)
  vi.stubEnv('PIEZO_WS_PORT', undefined)
  vi.stubEnv('SLEEPYPOD_MDNS', undefined)
  mocks.files.clear()
  mocks.existsSync.mockImplementation(path => mocks.files.has(path))
  mocks.readFileSync.mockImplementation(path => mocks.files.get(path))
  mocks.writeFileSync.mockImplementation((path, contents) => {
    mocks.files.set(path, contents)
  })
  mocks.unlinkSync.mockImplementation((path) => {
    mocks.files.delete(path)
  })
  mocks.execFileSync.mockImplementation(() => {
    throw new Error('No Avahi process')
  })
  mocks.advertise.mockResolvedValue(undefined)
  mocks.destroy.mockResolvedValue(undefined)
  mocks.shutdown.mockResolvedValue(undefined)
  mocks.createService.mockReturnValue({ advertise: mocks.advertise, destroy: mocks.destroy })
  mocks.getResponder.mockReturnValue({ createService: mocks.createService, shutdown: mocks.shutdown })
  signal = vi.spyOn(process, 'kill').mockReturnValue(true)
  logs = vi.spyOn(console, 'log').mockImplementation(() => {})
  warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  const { stopBonjourAnnouncement } = await import('../bonjourAnnounce')
  await stopBonjourAnnouncement()
  Reflect.deleteProperty(globalThis, STATE_KEY)
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('Pod discovery without Avahi', () => {
  it('publishes the existing DNS-SD contract and stable hostname without credentials', async () => {
    const { startBonjourAnnouncement } = await import('../bonjourAnnounce')
    await startBonjourAnnouncement()
    expect(mocks.createService).toHaveBeenCalledWith({
      name: 'sleepypod', type: 'sleepypod', hostname: 'eight-pod', port: 3000,
      txt: { wsPort: '3001', version: '1.0.0' },
    })
    expect(mocks.advertise).toHaveBeenCalledOnce()
    expect(mocks.writeFileSync).not.toHaveBeenCalled()
    expect(logs).toHaveBeenCalledWith(expect.stringContaining('via ciao'))
  })

  it('does not mistake a leftover Avahi directory or file for a running daemon', async () => {
    mocks.files.set('/etc/avahi', '')
    mocks.files.set(SERVICE_FILE, 'installed service')
    const { startBonjourAnnouncement } = await import('../bonjourAnnounce')
    await startBonjourAnnouncement()
    expect(mocks.advertise).toHaveBeenCalledOnce()
    expect(signal).not.toHaveBeenCalled()
    expect(mocks.files.get(SERVICE_FILE)).toBe('installed service')
  })

  it('does not advertise a development server by default', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const { startBonjourAnnouncement } = await import('../bonjourAnnounce')
    await startBonjourAnnouncement()
    expect(mocks.getResponder).not.toHaveBeenCalled()
    expect(mocks.execFileSync).not.toHaveBeenCalled()
  })

  it('supports explicit discovery in development and configured ports', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('SLEEPYPOD_MDNS', '1')
    vi.stubEnv('PORT', '4310')
    vi.stubEnv('PIEZO_WS_PORT', '4311')
    const { startBonjourAnnouncement } = await import('../bonjourAnnounce')
    await startBonjourAnnouncement()
    expect(mocks.createService).toHaveBeenCalledWith(expect.objectContaining({
      port: 4310, txt: { wsPort: '4311', version: '1.0.0' },
    }))
  })

  it('supports an explicit production opt-out', async () => {
    vi.stubEnv('SLEEPYPOD_MDNS', '0')
    const { startBonjourAnnouncement } = await import('../bonjourAnnounce')
    await startBonjourAnnouncement()
    expect(mocks.getResponder).not.toHaveBeenCalled()
  })

  it.each(['0', '65536', '-1', '3000<xml>', '3e3', ''])('rejects an invalid HTTP port %j without publication', async (value) => {
    vi.stubEnv('PORT', value)
    const { startBonjourAnnouncement } = await import('../bonjourAnnounce')
    await expect(startBonjourAnnouncement()).resolves.toBeUndefined()
    expect(mocks.getResponder).not.toHaveBeenCalled()
    expect(mocks.writeFileSync).not.toHaveBeenCalled()
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining('startup failed'), expect.any(Error))
  })

  it('also rejects an invalid WebSocket port', async () => {
    vi.stubEnv('PIEZO_WS_PORT', '70000')
    const { startBonjourAnnouncement } = await import('../bonjourAnnounce')
    await startBonjourAnnouncement()
    expect(mocks.getResponder).not.toHaveBeenCalled()
  })
})

describe('existing Avahi installations', () => {
  beforeEach(() => {
    mocks.execFileSync.mockReturnValue('432\n')
  })

  it('installs valid service data and reloads an actual daemon', async () => {
    vi.stubEnv('PORT', '4310')
    vi.stubEnv('PIEZO_WS_PORT', '4311')
    const { startBonjourAnnouncement } = await import('../bonjourAnnounce')
    await startBonjourAnnouncement()
    const document = mocks.files.get(SERVICE_FILE)
    expect(document).toContain('<type>_sleepypod._tcp</type>')
    expect(document).toContain('<port>4310</port>')
    expect(document).toContain('wsPort=4311')
    expect(signal).toHaveBeenCalledWith(432, 'SIGHUP')
    expect(mocks.getResponder).not.toHaveBeenCalled()
  })

  it('updates a stale port rather than announcing the wrong endpoint', async () => {
    mocks.files.set(SERVICE_FILE, '<port>9999</port>')
    const { startBonjourAnnouncement } = await import('../bonjourAnnounce')
    await startBonjourAnnouncement()
    expect(mocks.files.get(SERVICE_FILE)).toContain('<port>3000</port>')
  })

  it('can reuse a matching installer-owned file on a read-only filesystem', async () => {
    const { startBonjourAnnouncement, stopBonjourAnnouncement } = await import('../bonjourAnnounce')
    await startBonjourAnnouncement()
    const document = mocks.files.get(SERVICE_FILE) ?? ''
    expect(document).not.toBe('')
    await stopBonjourAnnouncement()
    mocks.files.set(SERVICE_FILE, document)
    mocks.writeFileSync.mockClear().mockImplementation(() => {
      throw new Error('EROFS')
    })
    await startBonjourAnnouncement()
    expect(mocks.writeFileSync).not.toHaveBeenCalled()
    expect(mocks.getResponder).not.toHaveBeenCalled()
  })

  it('falls back when a required service file cannot be written', async () => {
    mocks.writeFileSync.mockImplementation(() => {
      throw new Error('EROFS')
    })
    const { startBonjourAnnouncement } = await import('../bonjourAnnounce')
    await startBonjourAnnouncement()
    expect(mocks.advertise).toHaveBeenCalledOnce()
  })

  it('falls back when the daemon exits before reload', async () => {
    signal.mockImplementation(() => {
      throw new Error('ESRCH')
    })
    const { startBonjourAnnouncement } = await import('../bonjourAnnounce')
    await startBonjourAnnouncement()
    expect(mocks.advertise).toHaveBeenCalledOnce()
    expect(logs).not.toHaveBeenCalledWith(expect.stringContaining('via Avahi'))
  })

  it('does not signal invalid process IDs', async () => {
    mocks.execFileSync.mockReturnValue('0 1 -1 garbage')
    const { startBonjourAnnouncement } = await import('../bonjourAnnounce')
    await startBonjourAnnouncement()
    expect(signal).not.toHaveBeenCalled()
    expect(mocks.advertise).toHaveBeenCalledOnce()
  })

  it('withdraws its file and reports read-only withdrawal failures honestly', async () => {
    const { startBonjourAnnouncement, stopBonjourAnnouncement } = await import('../bonjourAnnounce')
    await startBonjourAnnouncement()
    mocks.unlinkSync.mockImplementation(() => {
      throw new Error('EROFS')
    })
    await expect(stopBonjourAnnouncement()).resolves.toBeUndefined()
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining('Could not withdraw'), expect.any(Error))
  })
})

describe('concurrent discovery lifecycle', () => {
  it('shares one announcement across repeated starts and module copies', async () => {
    const firstModule = await import('../bonjourAnnounce')
    const firstStart = firstModule.startBonjourAnnouncement()
    expect(firstModule.startBonjourAnnouncement()).toBe(firstStart)
    await firstStart
    vi.resetModules()
    const secondModule = await import('../bonjourAnnounce')
    await secondModule.startBonjourAnnouncement()
    expect(mocks.getResponder).toHaveBeenCalledOnce()
    await secondModule.stopBonjourAnnouncement()
    await firstModule.stopBonjourAnnouncement()
    expect(mocks.destroy).toHaveBeenCalledOnce()
    expect(mocks.shutdown).toHaveBeenCalledOnce()
    expect(mocks.destroy.mock.invocationCallOrder[0]).toBeLessThan(mocks.shutdown.mock.invocationCallOrder[0])
  })

  it('cancels before startup without acquiring a responder', async () => {
    const { startBonjourAnnouncement, stopBonjourAnnouncement } = await import('../bonjourAnnounce')
    const starting = startBonjourAnnouncement()
    await stopBonjourAnnouncement()
    await starting
    expect(mocks.getResponder).not.toHaveBeenCalled()
  })

  it('withdraws a pending publication once and never reports it as active afterward', async () => {
    const publication = deferred()
    mocks.advertise.mockReturnValue(publication.promise)
    const { startBonjourAnnouncement, stopBonjourAnnouncement } = await import('../bonjourAnnounce')
    const starting = startBonjourAnnouncement()
    await vi.waitFor(() => expect(mocks.advertise).toHaveBeenCalledOnce())
    await stopBonjourAnnouncement()
    publication.reject(new Error('Publication cancelled'))
    await starting
    expect(mocks.destroy).toHaveBeenCalledOnce()
    expect(mocks.shutdown).toHaveBeenCalledOnce()
    expect(logs).not.toHaveBeenCalledWith(expect.stringContaining('Advertising'))
    expect(warnings).not.toHaveBeenCalled()
  })

  it('waits for shutdown before acquiring a new responder', async () => {
    const withdrawal = deferred()
    const { startBonjourAnnouncement, stopBonjourAnnouncement } = await import('../bonjourAnnounce')
    await startBonjourAnnouncement()
    mocks.destroy.mockReturnValueOnce(withdrawal.promise)
    const stopping = stopBonjourAnnouncement()
    const restarting = startBonjourAnnouncement()
    await Promise.resolve()
    expect(mocks.getResponder).toHaveBeenCalledOnce()
    withdrawal.resolve()
    await stopping
    await restarting
    expect(mocks.getResponder).toHaveBeenCalledTimes(2)
  })

  it('cleans up failed publication and allows a later retry', async () => {
    mocks.advertise.mockRejectedValueOnce(new Error('Multicast unavailable'))
    const { startBonjourAnnouncement } = await import('../bonjourAnnounce')
    await startBonjourAnnouncement()
    expect(mocks.destroy).toHaveBeenCalledOnce()
    expect(mocks.shutdown).toHaveBeenCalledOnce()
    await startBonjourAnnouncement()
    expect(mocks.advertise).toHaveBeenCalledTimes(2)
  })

  it('automatically retries a transient startup failure without restarting the controller', async () => {
    vi.useFakeTimers()
    mocks.advertise.mockRejectedValueOnce(new Error('Network not ready'))
    const { startBonjourAnnouncement } = await import('../bonjourAnnounce')
    await startBonjourAnnouncement()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.advertise).toHaveBeenCalledTimes(2)
  })

  it('cancels automatic retry during shutdown', async () => {
    vi.useFakeTimers()
    mocks.advertise.mockRejectedValueOnce(new Error('Network not ready'))
    const { startBonjourAnnouncement, stopBonjourAnnouncement } = await import('../bonjourAnnounce')
    await startBonjourAnnouncement()
    await stopBonjourAnnouncement()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.advertise).toHaveBeenCalledOnce()
  })

  it('preserves pending withdrawal across a cancelled queued restart', async () => {
    const withdrawal = deferred()
    const { startBonjourAnnouncement, stopBonjourAnnouncement } = await import('../bonjourAnnounce')
    await startBonjourAnnouncement()
    mocks.destroy.mockReturnValueOnce(withdrawal.promise)
    const firstStop = stopBonjourAnnouncement()
    const cancelledStart = startBonjourAnnouncement()
    const secondStop = stopBonjourAnnouncement()
    const finalStart = startBonjourAnnouncement()
    await Promise.resolve()
    expect(mocks.getResponder).toHaveBeenCalledOnce()
    withdrawal.resolve()
    await Promise.all([firstStop, cancelledStart, secondStop, finalStart])
    expect(mocks.getResponder).toHaveBeenCalledTimes(2)
  })

  it('releases an acquired responder if service creation fails', async () => {
    mocks.createService.mockImplementationOnce(() => {
      throw new Error('Interface unavailable')
    })
    const { startBonjourAnnouncement } = await import('../bonjourAnnounce')
    await startBonjourAnnouncement()
    expect(mocks.shutdown).toHaveBeenCalledOnce()
    expect(mocks.destroy).not.toHaveBeenCalled()
  })

  it('still releases its shared responder reference when service withdrawal fails', async () => {
    const { startBonjourAnnouncement, stopBonjourAnnouncement } = await import('../bonjourAnnounce')
    await startBonjourAnnouncement()
    mocks.destroy.mockRejectedValueOnce(new Error('Network disappeared'))
    await stopBonjourAnnouncement()
    expect(mocks.shutdown).toHaveBeenCalledOnce()
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining('Could not withdraw'), expect.any(Error))
  })
})
